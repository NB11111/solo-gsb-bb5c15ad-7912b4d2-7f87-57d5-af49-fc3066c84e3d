/**
 * 滚动字幕消重：识别相邻 cue 构成的“连续滚动字幕”链并合并。
 *
 * 规则：
 * - 文本先归一化（去除 HTML/ASS 标签、标点、符号与空白并小写化，规则同 similarity.normalizeText），
 *   在归一化字符序列上计算相邻两项的“最长后缀-前缀重叠”（KMP 前缀函数，线性时间）。
 * - 两条相邻 cue 可连接，当且仅当：
 *   ① 时间相邻间隔（下一条开始 − 上一条结束）≤ maxGapMs（可为负，即时间重叠也算相邻）；
 *   ② 最长重叠长度 ≥ minOverlap（归一化字符数）。
 * - 全局动态规划（带权区间调度）选择互不重叠的连续链，按字典序依次：
 *   ① 最大化消除的重复字符数（链内相邻重叠长度之和）；
 *   ② 最小化合并组数；
 *   ③ 同分取更早的链（起始位置更早；起始相同则结束更早，即链更短）。
 * - 合并文本：链首全文 + 每条后续 cue 只追加“新增尾部”——
 *   按归一化重叠长度映射回原文字符位置，从该位置开始的原文片段（含其间标签/标点/空白）原样追加。
 * - 合并时间取链首开始与链末结束。
 */
export interface DedupOptions {
  /** 最大相邻间隔（毫秒）：下一条开始 − 上一条结束 ≤ 该值才允许连接 */
  maxGapMs: number;
  /** 最小文本重叠（去标签、标点、空白后的归一化字符数） */
  minOverlap: number;
}

/** 一条识别出的连续滚动字幕链（≥ 2 条 cue）。 */
export interface ScrollChain {
  /** 链内 cue 在输入序列中的下标（连续升序） */
  members: number[];
  /** 与 members 对齐的相邻重叠长度（长度 = members.length − 1，归一化字符数） */
  overlaps: number[];
  /** 与 members 对齐的相邻间隔（毫秒，下一条开始 − 上一条结束） */
  gaps: number[];
  /** 合并后文本：链首全文 + 仅追加的新增尾部 */
  mergedText: string;
  /** 链首开始时间（毫秒） */
  start: number;
  /** 链末结束时间（毫秒） */
  end: number;
  /** 消除的重复字符总数（相邻重叠长度之和） */
  savedChars: number;
}

export interface DedupCueLike {
  start: number;
  end: number;
  text: string;
}

/** 链内成员数上限，防止异常输入产生超长链 */
export const MAX_CHAIN_LEN = 512;

interface NormInfo {
  /** 归一化后的字符序列（规则同 similarity.normalizeText） */
  norm: string;
  /** norm[k] 在原文（含标签）中的起始下标（码元位置） */
  offset: number[];
}

const TAG_RE = /<[^>]*>|\{[^}]*\}/g;

/**
 * 归一化字幕文本，并记录每个归一化字符在原文中的起始下标。
 * 归一化规则必须与 similarity.normalizeText 保持一致；标签区间整体跳过，
 * 因此偏移可直接用于对原始文本切片（只追加新增尾部）。
 */
export function normalizeWithOffset(s: string): NormInfo {
  const lower = s.toLowerCase();
  const drop = /[\s\p{P}\p{S}]/u;
  const norm: string[] = [];
  const offset: number[] = [];
  let last = 0;
  TAG_RE.lastIndex = 0;
  for (const m of s.matchAll(TAG_RE)) {
    const idx = m.index ?? 0;
    for (let i = last; i < idx; i++) {
      const ch = lower[i];
      if (!drop.test(ch)) {
        norm.push(ch);
        offset.push(i);
      }
    }
    last = idx + m[0].length;
  }
  for (let i = last; i < s.length; i++) {
    const ch = lower[i];
    if (!drop.test(ch)) {
      norm.push(ch);
      offset.push(i);
    }
  }
  return { norm: norm.join(''), offset };
}

const TAIL_SKIP_RE = /[\s\p{P}\p{S}]/u;

/**
 * 计算“新增尾部”在原文中的起点：
 * 从归一化重叠长度对应的原文位置开始，向前回退越过重叠区末尾紧邻的标签 / 标点 / 空白，
 * 使包裹新增内容的开标签（如 <b>字幕|<b>消重</b>）或落在切点上的标点随尾部保留，
 * 同时避免切出孤立的闭合标签。
 */
function tailStart(raw: string, info: NormInfo, overlap: number): number {
  let p = overlap >= info.norm.length ? raw.length : info.offset[overlap];
  while (p > 0) {
    const rest = raw.slice(0, p);
    const tag = rest.match(/(<[^>]*>|\{[^}]*\})$/);
    if (tag && tag.index !== undefined) {
      p = tag.index;
      continue;
    }
    const ch = raw[p - 1];
    if (TAIL_SKIP_RE.test(ch)) {
      p--;
      continue;
    }
    break;
  }
  return p;
}

/**
 * 最长后缀-前缀重叠长度：a 的后缀与 b 的前缀相同的最大长度（可为 0）。
 * 用 KMP 前缀函数在拼接串 b + '\0' + a 上计算，末尾前缀函数值即答案。
 */
export function longestSuffixPrefixOverlap(a: string, b: string): number {
  if (a.length === 0 || b.length === 0) return 0;
  // '\0' 不会出现在去标签后的字幕文本中，作为不可跨越的分隔符
  const s = `${b}\0${a}`;
  const pi = new Array<number>(s.length).fill(0);
  for (let i = 1; i < s.length; i++) {
    let k = pi[i - 1];
    while (k > 0 && s[i] !== s[k]) k = pi[k - 1];
    if (s[i] === s[k]) k++;
    pi[i] = k;
  }
  // 分隔符保证匹配不会跨越边界；再夹一次避免极端输入
  return Math.min(pi[s.length - 1], a.length, b.length);
}

/** 计算一条候选链的合并文本与统计信息（members 连续、长度 ≥ 2）。 */
function buildChain(cues: DedupCueLike[], infos: NormInfo[], members: number[]): ScrollChain {
  const overlaps: number[] = [];
  const gaps: number[] = [];
  let saved = 0;
  let text = cues[members[0]].text;
  for (let t = 1; t < members.length; t++) {
    const prev = members[t - 1];
    const cur = members[t];
    const ov = longestSuffixPrefixOverlap(infos[prev].norm, infos[cur].norm);
    overlaps.push(ov);
    gaps.push(cues[cur].start - cues[prev].end);
    saved += ov;
    // 按归一化重叠位置映射回原文：新增尾部从重叠长度对应的原文偏移开始，原样追加。
    // 切点上紧邻的标签 / 标点回退到尾部保留（如 “字幕<b>消重” 的开标签随新增内容保留）。
    const info = infos[cur];
    text += cues[cur].text.slice(tailStart(cues[cur].text, info, ov));
    // ov === 归一化全长时尾部为空：当前项被上一项完全包含，无新增内容
  }
  return {
    members,
    overlaps,
    gaps,
    mergedText: text,
    start: cues[members[0]].start,
    end: cues[members[members.length - 1]].end,
    savedChars: saved,
  };
}

/**
 * 识别全部最优的互不重叠连续滚动字幕链。
 *
 * 底部向上的全局动态规划（带权区间调度）。dp[i] 表示只使用下标 ≥ i 的 cue：
 *   - 跳过 cue i：继承 dp[i+1]；
 *   - 取一条以 i 开头、j 结尾（j ≥ i+1，相邻连接全部成立）的链，
 *     得分 = 链内重叠和 + dp[j+1] 的得分。
 * 按字典序比较 [消除字符数 ↓, 合并组数 ↓, 链更早（起点↓，起点同则终点↓）]。
 */
export function findScrollChains(cues: DedupCueLike[], options: DedupOptions): ScrollChain[] {
  const n = cues.length;
  if (n < 2) return [];
  const minOverlap = Math.max(1, Math.floor(options.minOverlap) || 1);
  const maxGap = options.maxGapMs;

  const infos = cues.map((c) => normalizeWithOffset(c.text));

  // edge[i]：连接 i-1 → i 是否成立；ovLen[i]：该连接的归一化重叠长度
  const edge = new Array<boolean>(n).fill(false);
  const ovLen = new Int32Array(n);
  for (let i = 1; i < n; i++) {
    const ov = longestSuffixPrefixOverlap(infos[i - 1].norm, infos[i].norm);
    ovLen[i] = ov;
    edge[i] = cues[i].start - cues[i - 1].end <= maxGap && ov >= minOverlap;
  }

  // 后缀最优的标量得分；takeJ[i] 为选中链的结尾下标，-1 表示跳过 i
  const saved = new Int32Array(n + 1);
  const groups = new Int32Array(n + 1);
  const takeJ = new Int32Array(n + 1).fill(-1);

  for (let i = n - 1; i >= 0; i--) {
    // 初始最优：跳过 i（其第一条链起点 ≥ i+1）
    let bestSaved = saved[i + 1];
    let bestGroups = groups[i + 1];
    let bestJ = -1;

    // 枚举以 i 开头的链（j 递增；断边后更长的链均不成立）
    let runSaved = 0;
    for (let j = i + 1; j < n && j - i + 1 <= MAX_CHAIN_LEN; j++) {
      if (!edge[j]) break;
      runSaved += ovLen[j];
      const cs = runSaved + saved[j + 1];
      const cg = 1 + groups[j + 1];
      let replace = false;
      if (cs > bestSaved) replace = true;
      else if (cs === bestSaved && cg < bestGroups) replace = true;
      else if (cs === bestSaved && cg === bestGroups) {
        // 同分取更早链：取链（起点 i）早于跳过方案（起点 ≥ i+1）；
        // 与已选取链同起点时，j 递增枚举，先取到的链结束更早 → 不替换
        if (bestJ === -1) replace = true;
      }
      if (replace) {
        bestSaved = cs;
        bestGroups = cg;
        bestJ = j;
      }
    }
    saved[i] = bestSaved;
    groups[i] = bestGroups;
    takeJ[i] = bestJ;
  }

  // 回溯收集链
  const chosen: number[][] = [];
  let i = 0;
  while (i < n) {
    const j = takeJ[i];
    if (j >= 0) {
      const members: number[] = [];
      for (let t = i; t <= j; t++) members.push(t);
      chosen.push(members);
      i = j + 1;
    } else {
      i++;
    }
  }
  return chosen.map((members) => buildChain(cues, infos, members));
}

export interface DedupedCue {
  start: number;
  end: number;
  text: string;
  /** 链首 cue 的原始下标（非合并 cue 为其自身下标），供 UI 标识与采纳集合使用 */
  keyIndex: number;
  /** 被合并掉的原始 cue 下标（不含链首）；非合并 cue 为空 */
  absorbed: number[];
  /** 来源链（仅合并 cue 存在） */
  chain?: ScrollChain;
}

/** 依据采纳集合（元素为链首下标）把链压缩为合并 cue，未采纳链的 cue 原样保留。 */
export function dedupCues<T extends DedupCueLike>(
  cues: T[],
  chains: ScrollChain[],
  adopted: ReadonlySet<number>,
): DedupedCue[] {
  const byHead = new Map<number, ScrollChain>();
  for (const ch of chains) {
    if (adopted.has(ch.members[0])) byHead.set(ch.members[0], ch);
  }

  const out: DedupedCue[] = [];
  let i = 0;
  while (i < cues.length) {
    const ch = byHead.get(i);
    if (ch) {
      out.push({
        start: ch.start,
        end: ch.end,
        text: ch.mergedText,
        keyIndex: i,
        absorbed: ch.members.slice(1),
        chain: ch,
      });
      i = ch.members[ch.members.length - 1] + 1;
    } else {
      out.push({ start: cues[i].start, end: cues[i].end, text: cues[i].text, keyIndex: i, absorbed: [] });
      i++;
    }
  }
  return out;
}
