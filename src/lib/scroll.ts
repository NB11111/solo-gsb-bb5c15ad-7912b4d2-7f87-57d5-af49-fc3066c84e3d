/**
 * 滚动字幕消重：在合并结果上识别“连续滚动字幕”链并合并去重。
 *
 * - 相邻判定：合并结果按出现顺序排列；第 i+1 条开始时间不早于第 i 条，
 *   且两者间隔 start[i+1] − end[i] ≤ maxGapMs（负值表示时间区间重叠）。
 * - 重叠计算：文本去除 HTML 标签（<...>）、ASS 覆盖标签（{...}）、标点（\p{P}）
 *   与空白后得到字符序列（按 Unicode 码点切分，保留大小写），相邻项取前者最长后缀
 *   与后者最长前缀的重叠（对后者建 KMP 前缀函数）；重叠长度 ≥ minOverlap 才允许连接。
 * - 全局动态规划（带权区间调度）：可连接边 i→i+1 权重为重叠字符数，一条链覆盖连续
 *   区间 [a,b]（把 a..b 共 b−a+1 条合并成 1 条）。dp[i] 处理 cue[i..N)，转移为
 *   “跳过 i（dp[i+1]）”或“取从 i 出发的任一可连接链（链权重 + dp[链末+1]）”，
 *   按字典序比较：① 最大化消除的重复字符总数；② 最小化合并组数（链数）；
 *   ③ 同分时取更早链（首条下标更小；仍相同依次比较链末与下一条链）。
 * - 合并文本：链首全文 + 后续各项原文在重叠位置之后的“新增尾部”（标点/空白/标签
 *   原样保留，不做标签补全）；时间取链首条开始与末条结束。
 */
import type { MergedCue } from './merge';

export interface ScrollOptions {
  /** 允许连接的最大相邻间隔（毫秒）= 下一条开始 − 上一条结束；负值表示时间重叠 */
  maxGapMs: number;
  /** 相邻项最小重叠字符数（去除标签、标点、空白后的口径）；库内允许 0 */
  minOverlap: number;
}

export interface ScrollEdge {
  /** 前一条 cue 下标 */
  a: number;
  /** 后一条 cue 下标（恒为 a+1） */
  b: number;
  /** 归一化后的后缀-前缀重叠字符数 */
  overlap: number;
  /** b 的新增尾部在 b.text 中的起始 UTF-16 偏移（合并时 b.text.slice(tailStart)） */
  tailStart: number;
}

export interface ScrollChain {
  /** 稳定标识：成员 groupIndex 以 '-' 连接 */
  key: string;
  /** 成员 cue 下标（连续升序） */
  members: number[];
  /** 链首条开始时间（毫秒） */
  start: number;
  /** 链末条结束时间（毫秒） */
  end: number;
  /** 合并后的完整文本 */
  text: string;
  /** 累计消除的重复字符数（归一化口径，等于各边权重之和） */
  saved: number;
  /** 与 members 相邻对一一对应的连接信息（长度 = members.length - 1） */
  edges: { overlap: number; tailStart: number }[];
}

const TAG_RE = /<[^>]*>|\{[^}]*\}/g;
const PUNCT_RE = /^\p{P}$/u;
const SPACE_RE = /^\s$/u;

/* ---------------- 归一化序列 ---------------- */

interface VisibleSeq {
  /** 保留下来的可见字符（码点） */
  chars: string[];
  /** 每个保留字符在原文本中的起始 UTF-16 偏移 */
  start: number[];
}

/** 去除 HTML/ASS 标签，并返回“去标签文本码点下标 → 原文本 UTF-16 偏移”的映射。 */
function stripTagsMapped(s: string): { plain: string; map: number[] } {
  let plain = '';
  const map: number[] = [];
  let last = 0;
  const pushRange = (end: number) => {
    for (let p = last; p < end; ) {
      const cp = s.codePointAt(p)!;
      map.push(p);
      plain += String.fromCodePoint(cp);
      p += cp > 0xffff ? 2 : 1;
    }
  };
  for (const m of s.matchAll(TAG_RE)) {
    const idx = m.index ?? 0;
    pushRange(idx);
    last = idx + m[0].length;
  }
  pushRange(s.length);
  return { plain, map };
}

/** 去除标签、标点与空白后的字符序列及其在原文中的偏移（保留大小写）。 */
function visibleSeq(s: string): VisibleSeq {
  const { plain, map } = stripTagsMapped(s);
  const chars: string[] = [];
  const start: number[] = [];
  let pi = 0;
  for (const ch of plain) {
    if (!SPACE_RE.test(ch) && !PUNCT_RE.test(ch)) {
      chars.push(ch);
      start.push(map[pi]);
    }
    pi++;
  }
  return { chars, start };
}

/** 导出供测试/界面使用：去标签、标点、空白后的重叠计算字符序列。 */
export function overlapSequence(s: string): string {
  return visibleSeq(s).chars.join('');
}

/* ---------------- 后缀-前缀重叠（KMP） ---------------- */

/**
 * 序列 a 的最长后缀与序列 b 的最长前缀的公共长度（0..min(|a|,|b|)）。
 * 对 b 建前缀函数后流式扫描 a：扫描中一旦完整匹配 b 立即回退（与标准 KMP
 * 查找一致），最终 q 即 a 末尾对 b 前缀的最长匹配长度。
 */
export function suffixPrefixOverlap(a: readonly string[], b: readonly string[]): number {
  if (a.length === 0 || b.length === 0) return 0;
  const pf = new Array<number>(b.length).fill(0);
  for (let i = 1; i < b.length; i++) {
    let k = pf[i - 1];
    while (k > 0 && b[i] !== b[k]) k = pf[k - 1];
    if (b[i] === b[k]) k++;
    pf[i] = k;
  }
  let q = 0;
  for (let t = 0; t < a.length; t++) {
    while (q > 0 && a[t] !== b[q]) q = pf[q - 1];
    if (a[t] === b[q]) q++;
    if (q === b.length && t < a.length - 1) q = pf[q - 1];
  }
  return q;
}

/* ---------------- 相邻边与链构建 ---------------- */

function edgeBetween(i: number, seqs: VisibleSeq[], cues: MergedCue[], opts: ScrollOptions): ScrollEdge | null {
  const a = cues[i];
  const b = cues[i + 1];
  if (b.start < a.start) return null; // 顺序保护：开始时间不得倒退
  if (b.start - a.end > opts.maxGapMs) return null;
  const seqA = seqs[i];
  const seqB = seqs[i + 1];
  const overlap = suffixPrefixOverlap(seqA.chars, seqB.chars);
  if (overlap < opts.minOverlap) return null;
  // 重叠前缀之后的首个可见字符即“新增尾部”起点；b 完全被包含时追加空串
  const tailStart =
    overlap < seqB.chars.length ? seqB.start[overlap] : b.text.length;
  return { a: i, b: i + 1, overlap, tailStart };
}

function buildChain(
  a: number,
  b: number,
  cues: MergedCue[],
  edges: (ScrollEdge | null)[],
): ScrollChain {
  const members: number[] = [];
  for (let k = a; k <= b; k++) members.push(k);
  let text = cues[a].text;
  let saved = 0;
  const chainEdges: ScrollChain['edges'] = [];
  for (let k = a; k < b; k++) {
    const e = edges[k]!;
    text += cues[k + 1].text.slice(e.tailStart);
    saved += e.overlap;
    chainEdges.push({ overlap: e.overlap, tailStart: e.tailStart });
  }
  return {
    key: members.map((m) => cues[m].groupIndex).join('-'),
    members,
    start: cues[a].start,
    end: cues[b].end,
    text,
    saved,
    edges: chainEdges,
  };
}

/* ---------------- 全局动态规划 ---------------- */

interface DpNode {
  /** 该方案累计消除的重复字符数（越大越好） */
  w: number;
  /** 该方案的合并组数（越少越好） */
  groups: number;
  /** 本节点链的首/末 cue 下标；-1 表示本节点为“跳过”，不引入链 */
  headStart: number;
  headEnd: number;
  /** 后续方案 */
  tail: DpNode | null;
}

const EMPTY: DpNode = { w: 0, groups: 0, headStart: -1, headEnd: -1, tail: null };

/** 同分（w、groups 均相同）时，链区间序列 (start,end) 字典序更小者为“更早链”。 */
function earlierChainList(x: DpNode, y: DpNode): boolean {
  let a: DpNode | null = x;
  let b: DpNode | null = y;
  while (a && b && a.headStart !== -1 && b.headStart !== -1) {
    if (a.headStart !== b.headStart) return a.headStart < b.headStart;
    if (a.headEnd !== b.headEnd) return a.headEnd < b.headEnd;
    a = a.tail;
    b = b.tail;
  }
  // 一方已无链：有链的一方在该位置更早（前面的链区间完全相同，不可能到达这里）
  return a !== null && b !== null && a.headStart !== -1 && b.headStart === -1;
}

function better(x: DpNode, y: DpNode): boolean {
  if (x.w !== y.w) return x.w > y.w;
  if (x.groups !== y.groups) return x.groups < y.groups;
  return earlierChainList(x, y);
}

/** 识别当前合并结果中的互不重叠连续滚动字幕链（按要求的三级目标全局最优）。 */
export function findScrollChains(cues: MergedCue[], options: ScrollOptions): ScrollChain[] {
  const opts: ScrollOptions = {
    maxGapMs: Number.isFinite(options.maxGapMs) ? options.maxGapMs : 0,
    minOverlap: Math.max(0, Math.floor(options.minOverlap) || 0),
  };
  const n = cues.length;
  if (n < 2) return [];

  const seqs = cues.map((c) => visibleSeq(c.text));
  const edges: (ScrollEdge | null)[] = new Array(n - 1);
  for (let i = 0; i < n - 1; i++) edges[i] = edgeBetween(i, seqs, cues, opts);

  // dp[i]：处理 cue[i..n) 的最优方案节点
  const dp: DpNode[] = new Array(n + 1);
  dp[n] = EMPTY;
  for (let i = n - 1; i >= 0; i--) {
    // 跳过 i
    let best: DpNode = { w: dp[i + 1].w, groups: dp[i + 1].groups, headStart: -1, headEnd: -1, tail: dp[i + 1] };
    // 取从 i 开始、沿可连接边延伸的每个候选链
    let weight = 0;
    let j = i;
    while (j + 1 < n && edges[j]) {
      weight += edges[j]!.overlap;
      const sub = dp[j + 2];
      const cand: DpNode = {
        w: weight + sub.w,
        groups: 1 + sub.groups,
        headStart: i,
        headEnd: j + 1,
        tail: sub,
      };
      if (better(cand, best)) best = cand;
      j++;
    }
    dp[i] = best;
  }

  // 回溯收集链（链互不重叠且按位置升序）
  const chains: ScrollChain[] = [];
  let i = 0;
  while (i < n) {
    const node = dp[i];
    if (node.headStart === i) {
      chains.push(buildChain(i, node.headEnd, cues, edges));
      i = node.headEnd + 1;
    } else {
      i++;
    }
  }
  return chains;
}

/* ---------------- 采纳与输出 ---------------- */

/**
 * 按已采纳链（key 集合）折叠合并结果：命中的连续区间替换为一条合并 cue，
 * groupIndex 取链首条；未采纳的 cue 原样保留。已失效（不在 chains 中）的
 * key 会被忽略。
 */
export function applyScrollChains(
  cues: MergedCue[],
  chains: ScrollChain[],
  accepted: ReadonlySet<string>,
): MergedCue[] {
  const byStart = new Map<number, ScrollChain>();
  for (const ch of chains) {
    if (accepted.has(ch.key)) byStart.set(ch.members[0], ch);
  }
  const out: MergedCue[] = [];
  for (let i = 0; i < cues.length; ) {
    const ch = byStart.get(i);
    if (ch) {
      out.push({ start: ch.start, end: ch.end, text: ch.text, groupIndex: cues[i].groupIndex });
      i = ch.members[ch.members.length - 1] + 1;
    } else {
      out.push(cues[i]);
      i++;
    }
  }
  return out;
}
