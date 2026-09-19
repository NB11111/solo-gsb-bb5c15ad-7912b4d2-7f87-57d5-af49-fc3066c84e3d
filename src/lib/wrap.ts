/**
 * 智能断行：把合并后的字幕文本按显示宽度重新分行。
 *
 * - 宽度按 Unicode 字素簇（grapheme cluster）计算：全角计 2、半角计 1；
 *   HTML 标签（<...>）与 ASS 覆盖标签（{...}）原样保留但不计入宽度。
 * - 动态规划在空白或标点边界选择断点，按字典序依次最小化：
 *   1) 超限宽度（超出每行最大宽度的总量）；
 *   2) 行宽差（先让最窄行尽量宽、再让最宽行尽量窄，即最小化行宽极差）；
 *   3) 避头尾惩罚：行首为“，。！？；：、）】》”或行尾为“（【《”。
 * - 已有手工换行（\n）可锁定为不可跨越的边界；解锁后按普通空白处理。
 * - 若最优方案仍超宽或行数超限，返回失败原因，由调用方决定不应用。
 */

export interface WrapOptions {
  /** 每行最大显示宽度（全角 2 / 半角 1） */
  maxWidth: number;
  /** 最多行数 */
  maxLines: number;
  /** 锁定已有手工换行为不可跨越边界 */
  lockManualBreaks: boolean;
}

export interface WrapSuccess {
  ok: true;
  /** 断行后的各行（标签已保留在原文位置） */
  lines: string[];
  /** 各行显示宽度 */
  widths: number[];
  /** lines.join('\n')，可直接作为字幕文本 */
  text: string;
  /** 结果是否与原文不同 */
  changed: boolean;
}

export interface WrapFailure {
  ok: false;
  /** 无法满足限制的原因 */
  reason: string;
}

export type WrapResult = WrapSuccess | WrapFailure;

/** 行首避头字符（行首出现则产生惩罚） */
export const BAD_LINE_START_CHARS = '，。！？；：、）】》';
/** 行尾避尾字符（行尾出现则产生惩罚） */
export const BAD_LINE_END_CHARS = '（【《';

const BAD_START = new Set(BAD_LINE_START_CHARS);
const BAD_END = new Set(BAD_LINE_END_CHARS);

/** 超出该字素数的文本不做断行（防止极端输入导致 DP 过慢） */
const MAX_ATOMS = 4000;

/* ---------------- 字素簇与显示宽度 ---------------- */

type GraphemeSegmenter = { segment(input: string): Iterable<{ segment: string }> };
const SegmenterCtor = (
  Intl as unknown as {
    Segmenter?: new (
      locales?: string | string[],
      options?: { granularity: 'grapheme' },
    ) => GraphemeSegmenter;
  }
).Segmenter;
const segmenter = SegmenterCtor ? new SegmenterCtor(undefined, { granularity: 'grapheme' }) : null;

/** 把字符串切分为 Unicode 字素簇（环境不支持 Intl.Segmenter 时按码点回退）。 */
export function graphemes(s: string): string[] {
  if (segmenter) {
    const out: string[] = [];
    for (const seg of segmenter.segment(s)) out.push(seg.segment);
    return out;
  }
  // 回退：按码点切分，把组合符 / 变体选择符 / emoji 修饰符合并到前一个簇
  const out: string[] = [];
  for (const ch of s) {
    const cp = ch.codePointAt(0)!;
    const joinPrev =
      out.length > 0 &&
      (/^\p{M}$/u.test(ch) ||
        cp === 0x200d ||
        cp === 0xfe0e ||
        cp === 0xfe0f ||
        (cp >= 0x1f3fb && cp <= 0x1f3ff) ||
        out[out.length - 1].endsWith('\u200d'));
    if (joinPrev) out[out.length - 1] += ch;
    else out.push(ch);
  }
  return out;
}

/** 东亚宽字符（W/F）与 emoji 区间，命中则字素簇宽度计 2。 */
const WIDE_RE = new RegExp(
  `[${[
    '\\u1100-\\u115F', // Hangul Jamo
    '\\u2329-\\u232A', // 尖括号
    '\\u2E80-\\uA4CF', // CJK 部首/假名/汉字/标点（含 。、「」等）
    '\\uAC00-\\uD7A3', // Hangul 音节
    '\\uF900-\\uFAFF', // CJK 兼容表意
    '\\uFE10-\\uFE19', // 竖排标点
    '\\uFE30-\\uFE4F', // CJK 兼容形式
    '\\uFE54-\\uFE66\\uFE68-\\uFE6B', // 小型变体
    '\\uFF00-\\uFF60\\uFFE0-\\uFFE6', // 全角形式
    '\\u{1F000}-\\u{1FAFF}', // emoji 与游戏符号
    '\\u{20000}-\\u{3FFFD}', // CJK 扩展 B 及以后
  ].join('')}]`,
  'u',
);

/** 单个字素簇的显示宽度：全角 2、半角 1、控制符/组合符 0。 */
export function clusterWidth(g: string): number {
  if (g === '') return 0;
  const cp = g.codePointAt(0)!;
  if (cp < 0x20 || cp === 0x7f) return 0; // 控制字符（含 \n \t）
  if (cp === 0x200d || cp === 0xfe0e || cp === 0xfe0f) return 0; // ZWJ / 变体选择符
  if (/^\p{M}/u.test(g)) return 0; // 组合附加符
  if (g.includes('\u20e3')) return 2; // keycap 序列
  if (g.length > 1 && g.includes('\ufe0f')) return 2; // emoji 表现型序列
  return WIDE_RE.test(String.fromCodePoint(cp)) ? 2 : 1;
}

/** 文本的显示宽度：去除 HTML/ASS 标签后按字素簇求和。 */
export function displayWidth(text: string): number {
  const plain = text.replace(/<[^>]*>|\{[^}]*\}/g, '');
  let w = 0;
  for (const g of graphemes(plain)) w += clusterWidth(g);
  return w;
}

/* ---------------- 原子化（字素 + 标签附着） ---------------- */

interface Atom {
  /** 原始文本（含附着在前面的标签） */
  text: string;
  /** 裸字素（不含标签），用于空白/标点分类 */
  ch: string;
  width: number;
  /** 是否可吸收空白（断行时被消耗，不出现在行首行尾） */
  space: boolean;
}

const TAG_RE = /<[^>]*>|\{[^}]*\}/g;
const PUNCT_RE = /^\p{P}$/u;
/** 可断空白（不含 nbsp 等不换行空格） */
const BREAK_SPACE_RE = /^[^\S\u00a0\u2007\u202f]$/u;

function spaceWidth(g: string): number {
  return g === '\u3000' ? 2 : 1;
}

/** 把一行（不含 \n）切为原子序列；标签零宽并附着到相邻字素上。 */
function tokenize(line: string): Atom[] {
  const atoms: Atom[] = [];
  let pending = '';
  let last = 0;
  const pushText = (s: string) => {
    for (const g of graphemes(s)) {
      const space = BREAK_SPACE_RE.test(g);
      if (pending !== '' && space && atoms.length > 0) {
        // 空白前的标签附着到前一个原子，避免断行吸收空白时丢失标签
        atoms[atoms.length - 1].text += pending;
        pending = '';
      }
      atoms.push({ text: pending + g, ch: g, width: space ? spaceWidth(g) : clusterWidth(g), space });
      pending = '';
    }
  };
  for (const m of line.matchAll(TAG_RE)) {
    const idx = m.index ?? 0;
    pushText(line.slice(last, idx));
    pending += m[0];
    last = idx + m[0].length;
  }
  pushText(line.slice(last));
  if (pending !== '') {
    // 行尾的标签附着到前一个原子；整行都是标签时单独成原子
    if (atoms.length > 0) atoms[atoms.length - 1].text += pending;
    else atoms.push({ text: pending, ch: '', width: 0, space: false });
  }
  return atoms;
}

/** 把整段文本原子化；lockManualBreaks 时手工换行成为强制断点，否则当作空白。 */
function buildAtoms(text: string, lockManualBreaks: boolean): { atoms: Atom[]; forced: number[] } {
  if (!lockManualBreaks) return { atoms: tokenize(text.replace(/\n+/g, ' ')), forced: [] };
  const atoms: Atom[] = [];
  const forced: number[] = [];
  for (const line of text.split(/\n+/)) {
    const seg = tokenize(line);
    // 跳过没有可见内容的手工行（全空白），避免产生空行
    if (!seg.some((a) => a.ch !== '' && !a.space)) continue;
    if (atoms.length > 0) forced.push(atoms.length);
    atoms.push(...seg);
  }
  return { atoms, forced };
}

/* ---------------- 动态规划 ---------------- */

/** 费用向量 [超限宽度, 负的最窄行宽, 最宽行宽, 避头尾惩罚]，字典序越小越好。 */
type Cost = readonly [number, number, number, number];
const UNREACH: Cost = [Infinity, Infinity, Infinity, Infinity];

function better(a: Cost, b: Cost): boolean {
  for (let i = 0; i < 4; i++) {
    if (a[i] < b[i]) return true;
    if (a[i] > b[i]) return false;
  }
  return false;
}

/** 智能断行主入口。 */
export function smartWrap(text: string, options: WrapOptions): WrapResult {
  const maxWidth = Math.max(1, Math.floor(options.maxWidth) || 1);
  const maxLines = Math.max(1, Math.floor(options.maxLines) || 1);
  const { atoms, forced } = buildAtoms(text, options.lockManualBreaks);
  const N = atoms.length;

  if (N === 0) {
    // 空文本或仅含标签/空白：原样返回，不视为变化
    const lines = text === '' ? [] : [text];
    return { ok: true, lines, widths: lines.map((l) => displayWidth(l)), text, changed: false };
  }
  if (N > MAX_ATOMS) {
    return { ok: false, reason: `文本过长（${N} 个字素），超出智能断行处理上限` };
  }

  // 前缀宽度
  const pref = new Array<number>(N + 1);
  pref[0] = 0;
  for (let i = 0; i < N; i++) pref[i + 1] = pref[i] + atoms[i].width;

  // nextNS[i]：从 i 起第一个非空白原子；prevNS[i]：不晚于 i 的最后一个非空白原子
  const nextNS = new Array<number>(N + 1).fill(N);
  for (let i = N - 1; i >= 0; i--) nextNS[i] = atoms[i].space ? nextNS[i + 1] : i;
  const prevNS = new Array<number>(N).fill(-1);
  for (let i = 0; i < N; i++) prevNS[i] = atoms[i].space ? (i === 0 ? -1 : prevNS[i - 1]) : i;

  /** 段 (k, j) 去掉首尾空白后的信息；空段返回 null。 */
  const segOf = (k: number, j: number): { w: number; lead: number; last: number } | null => {
    const lead = nextNS[k];
    if (lead >= j) return null;
    const last = prevNS[j - 1];
    return { w: pref[last + 1] - pref[lead], lead, last };
  };
  const render = (lead: number, end: number): string => {
    let s = '';
    for (let t = lead; t < end; t++) s += atoms[t].text;
    return s;
  };

  // 断点候选：空白串末尾、标点之前或之后
  const brk = new Array<boolean>(N + 1).fill(false);
  for (let p = 1; p < N; p++) {
    const prev = atoms[p - 1];
    const next = atoms[p];
    if (prev.space) {
      if (!next.space) brk[p] = true;
      continue;
    }
    if (next.space) continue; // 空白串起点不断（等价于串尾断）
    if (PUNCT_RE.test(prev.ch) || PUNCT_RE.test(next.ch)) brk[p] = true;
  }

  // 强制断点（锁定的手工换行）
  const isForced = new Array<boolean>(N + 1).fill(false);
  for (const f of forced) isForced[f] = true;
  const nextForced = new Array<number>(N + 1).fill(N);
  for (let k = N - 1; k >= 0; k--) nextForced[k] = isForced[k + 1] ? k + 1 : nextForced[k + 1];

  // dp[k][l]：atoms[k..N) 恰好用 l 行的最小费用
  const L = Math.min(maxLines, N);
  const cost: Cost[][] = Array.from({ length: N + 1 }, () => Array<Cost>(L + 1).fill(UNREACH));
  const choice: Int32Array[] = Array.from({ length: N + 1 }, () => new Int32Array(L + 1).fill(-1));

  for (let k = N - 1; k >= 0; k--) {
    const f = nextForced[k];
    for (let l = 1; l <= L; l++) {
      let best: Cost = UNREACH;
      let bestJ = -1;
      for (let j = k + 1; j <= f; j++) {
        if (j !== f && !brk[j]) continue;
        const seg = segOf(k, j);
        if (!seg) continue;
        let punct = 0;
        if (k > 0 && BAD_START.has(atoms[seg.lead].ch)) punct++;
        if (j < N && BAD_END.has(atoms[seg.last].ch)) punct++;
        const ov = seg.w > maxWidth ? seg.w - maxWidth : 0;
        let total: Cost;
        if (j === N) {
          if (l !== 1) continue;
          total = [ov, -seg.w, seg.w, punct];
        } else {
          const sub = cost[j][l - 1];
          if (sub[0] === Infinity) continue;
          total = [ov + sub[0], Math.max(-seg.w, sub[1]), Math.max(seg.w, sub[2]), punct + sub[3]];
        }
        if (better(total, best)) {
          best = total;
          bestJ = j;
        }
      }
      cost[k][l] = best;
      choice[k][l] = bestJ;
    }
  }

  // 在不超过行数限制的方案中取最优（并列时偏好行数更少）
  let bestL = 0;
  let best: Cost = UNREACH;
  for (let l = 1; l <= L; l++) {
    if (better(cost[0][l], best)) {
      best = cost[0][l];
      bestL = l;
    }
  }

  if (bestL > 0 && best[0] === 0) {
    const lines: string[] = [];
    const widths: number[] = [];
    let k = 0;
    let l = bestL;
    while (k < N && l > 0) {
      const j = choice[k][l];
      const seg = segOf(k, j);
      if (!seg || j <= k) break;
      lines.push(render(seg.lead, seg.last + 1));
      widths.push(seg.w);
      k = j;
      l--;
    }
    if (lines.length > 0 && k === N) {
      const out = lines.join('\n');
      return { ok: true, lines, widths, text: out, changed: out !== text };
    }
  }

  // ---- 失败诊断 ----
  // 1) 是否存在任何断行方案都无法容纳的超宽片段（相邻断点之间的最宽段）
  const bounds: number[] = [0];
  for (let p = 1; p < N; p++) if (brk[p] || isForced[p]) bounds.push(p);
  bounds.push(N);
  let worstW = -1;
  let worstText = '';
  for (let t = 0; t + 1 < bounds.length; t++) {
    const seg = segOf(bounds[t], bounds[t + 1]);
    if (seg && seg.w > worstW) {
      worstW = seg.w;
      worstText = render(seg.lead, seg.last + 1);
    }
  }
  if (worstW > maxWidth) {
    const shown = worstText.length > 16 ? `${worstText.slice(0, 15)}…` : worstText;
    return {
      ok: false,
      reason: `存在无法断开的片段「${shown}」（宽 ${worstW}），超过每行最大宽度 ${maxWidth}`,
    };
  }
  // 2) 宽度可满足但行数不够：求不超宽前提下的最少行数
  const ml = new Array<number>(N + 1).fill(Infinity);
  ml[N] = 0;
  for (let k = N - 1; k >= 0; k--) {
    const f = nextForced[k];
    for (let j = k + 1; j <= f; j++) {
      if (j !== f && !brk[j]) continue;
      const seg = segOf(k, j);
      if (!seg || seg.w > maxWidth || ml[j] === Infinity) continue;
      if (ml[j] + 1 < ml[k]) ml[k] = ml[j] + 1;
    }
  }
  const need = ml[0];
  return {
    ok: false,
    reason:
      need === Infinity
        ? `在当前断点规则下无法分行`
        : `按每行宽度 ${maxWidth} 至少需要 ${need} 行，超过最多行数 ${maxLines}`,
  };
}
