/**
 * 顺序对齐算法：基于动态规划（带合并移动的序列比对）。
 *
 * 在 (i, j) 处允许五种移动：
 *  - 1:1   消费 A[i] 与 B[j]
 *  - N:1   消费 A 的连续 k 条与 B[j]（k ≤ MAX_SPAN）
 *  - 1:N   消费 A[i] 与 B 的连续 l 条
 *  - 跳过 A[i]（仅 A 片段）/ 跳过 B[j]（仅 B 片段）
 *
 * 匹配得分 = 2·(0.6·文本相似度 + 0.4·时间重叠度) − 1， ∈ [-1, 1]；
 * 跳过代价 −0.4，合并每多一条额外罚 0.12。大输入自动启用带状 DP 控制开销。
 */
import type { Cue } from './srt';
import { bigramDice, normalizeText, timeDice } from './similarity';

export type GroupKind = '1:1' | '1:N' | 'N:1' | 'A-only' | 'B-only';

export interface AlignGroup {
  id: string;
  /** 命中的 A 版本 cue 索引（升序） */
  aIdx: number[];
  /** 命中的 B 版本 cue 索引（升序） */
  bIdx: number[];
  kind: GroupKind;
  /** 归一化文本相似度 ∈ [0,1]（单边组为 0） */
  textSim: number;
  /** 时间重叠度 ∈ [0,1]（单边组为 0） */
  timeOverlap: number;
  /** 综合置信度 ∈ [0,1] */
  confidence: number;
}

const MAX_SPAN = 4;
const SKIP_PENALTY = -0.4;
const MERGE_PENALTY = 0.12;
const W_TEXT = 0.6;
const W_TIME = 0.4;
const FULL_CELL_LIMIT = 2_000_000;
const BAND_WIDTH = 200;
const NEG = -1e9;

const BP_DIAG = 0;
const BP_UP = 1;
const BP_LEFT = 2;
const BP_MERGE_A_BASE = 3; // 3 + (k-2)，k ∈ [2, MAX_SPAN]
const BP_MERGE_B_BASE = 3 + (MAX_SPAN - 1); // + (l-2)

function pairScore(textSim: number, timeOv: number): number {
  return 2 * (W_TEXT * textSim + W_TIME * timeOv) - 1;
}

const isNeg = (v: number) => v <= NEG / 2;

export function alignCues(cuesA: Cue[], cuesB: Cue[]): AlignGroup[] {
  const n = cuesA.length;
  const m = cuesB.length;
  const groups: AlignGroup[] = [];

  const normA = cuesA.map((c) => normalizeText(c.text));
  const normB = cuesB.map((c) => normalizeText(c.text));

  const makeGroup = (aIdx: number[], bIdx: number[]): AlignGroup => {
    const kind: GroupKind =
      aIdx.length === 0
        ? 'B-only'
        : bIdx.length === 0
          ? 'A-only'
          : aIdx.length === 1 && bIdx.length === 1
            ? '1:1'
            : aIdx.length > 1
              ? 'N:1'
              : '1:N';
    let textSim = 0;
    let timeOverlap = 0;
    let confidence = 0;
    if (aIdx.length > 0 && bIdx.length > 0) {
      textSim = bigramDice(
        aIdx.map((i) => normA[i]).join(''),
        bIdx.map((i) => normB[i]).join(''),
      );
      const sa = Math.min(...aIdx.map((i) => cuesA[i].start));
      const ea = Math.max(...aIdx.map((i) => cuesA[i].end));
      const sb = Math.min(...bIdx.map((i) => cuesB[i].start));
      const eb = Math.max(...bIdx.map((i) => cuesB[i].end));
      timeOverlap = timeDice(sa, ea, sb, eb);
      confidence = W_TEXT * textSim + W_TIME * timeOverlap;
    }
    return { id: `g${groups.length}`, aIdx, bIdx, kind, textSim, timeOverlap, confidence };
  };

  if (n === 0 && m === 0) return groups;
  if (n === 0) return [makeGroup([], cuesB.map((_, i) => i))];
  if (m === 0) return [makeGroup(cuesA.map((_, i) => i), [])];

  const banded = (n + 1) * (m + 1) > FULL_CELL_LIMIT;
  const W = banded ? BAND_WIDTH : Math.max(n, m);
  const ROWS = MAX_SPAN + 1;
  const width = 2 * W + 1;
  const colOf = (i: number, j: number) => j - i + W;

  // dp 环形缓冲（转移最多回看 MAX_SPAN 行）；回退指针全量保存
  const ring: Float64Array[] = Array.from({ length: ROWS }, () => new Float64Array(width));
  const bp: Uint8Array[] = Array.from({ length: n + 1 }, () => new Uint8Array(width));
  const colM = new Float64Array(n + 1).fill(NEG); // 每行 j=m 处的快照，用于终点选择

  // 单对文本相似度记忆表（-1 表示未计算）
  const tsMemo = new Float32Array((n + 1) * width).fill(-1);
  const pairTs = (i: number, j: number): number => {
    const key = i * width + colOf(i, j);
    const cached = tsMemo[key];
    if (cached >= 0) return cached;
    const v = bigramDice(normA[i], normB[j]);
    tsMemo[key] = v;
    return v;
  };

  const getDp = (i: number, j: number, curI: number): number => {
    if (i < 0 || j < 0 || j > m || curI - i >= ROWS) return NEG;
    const c = colOf(i, j);
    if (c < 0 || c >= width) return NEG;
    return ring[i % ROWS][c];
  };

  /** A[i0..i1] 合并后与 B[j] 的匹配得分（含合并惩罚）；无望时返回 NEG 提前剪枝。 */
  const mergeScoreA = (i0: number, i1: number, j: number): number => {
    let start = Infinity;
    let end = -Infinity;
    for (let k = i0; k <= i1; k++) {
      start = Math.min(start, cuesA[k].start);
      end = Math.max(end, cuesA[k].end);
    }
    const td = timeDice(start, end, cuesB[j].start, cuesB[j].end);
    if (td < 0.02 && pairTs(i1, j) < 0.3) return NEG;
    let merged = '';
    for (let k = i0; k <= i1; k++) merged += normA[k];
    const ts = bigramDice(merged, normB[j]);
    return pairScore(ts, td) - MERGE_PENALTY * (i1 - i0);
  };

  /** A[i] 与 B[j0..j1] 合并后的匹配得分。 */
  const mergeScoreB = (i: number, j0: number, j1: number): number => {
    let start = Infinity;
    let end = -Infinity;
    for (let k = j0; k <= j1; k++) {
      start = Math.min(start, cuesB[k].start);
      end = Math.max(end, cuesB[k].end);
    }
    const td = timeDice(cuesA[i].start, cuesA[i].end, start, end);
    if (td < 0.02 && pairTs(i, j1) < 0.3) return NEG;
    let merged = '';
    for (let k = j0; k <= j1; k++) merged += normB[k];
    const ts = bigramDice(normA[i], merged);
    return pairScore(ts, td) - MERGE_PENALTY * (j1 - j0);
  };

  for (let i = 0; i <= n; i++) {
    const row = ring[i % ROWS];
    row.fill(NEG);
    const jLo = Math.max(0, i - W);
    const jHi = Math.min(m, i + W);
    for (let j = jLo; j <= jHi; j++) {
      const c = colOf(i, j);
      if (i === 0 && j === 0) {
        row[c] = 0;
        continue;
      }
      if (i === 0) {
        row[c] = getDp(0, j - 1, i) + SKIP_PENALTY;
        bp[i][c] = BP_LEFT;
        continue;
      }
      if (j === 0) {
        row[c] = getDp(i - 1, 0, i) + SKIP_PENALTY;
        bp[i][c] = BP_UP;
        continue;
      }
      let best = NEG;
      let bestBp = BP_DIAG;
      // 1:1
      const prevDiag = getDp(i - 1, j - 1, i);
      if (!isNeg(prevDiag)) {
        const v =
          prevDiag +
          pairScore(
            pairTs(i - 1, j - 1),
            timeDice(cuesA[i - 1].start, cuesA[i - 1].end, cuesB[j - 1].start, cuesB[j - 1].end),
          );
        if (v > best) {
          best = v;
          bestBp = BP_DIAG;
        }
      }
      // 仅 A
      const prevUp = getDp(i - 1, j, i);
      if (!isNeg(prevUp)) {
        const v = prevUp + SKIP_PENALTY;
        if (v > best) {
          best = v;
          bestBp = BP_UP;
        }
      }
      // 仅 B
      const prevLeft = getDp(i, j - 1, i);
      if (!isNeg(prevLeft)) {
        const v = prevLeft + SKIP_PENALTY;
        if (v > best) {
          best = v;
          bestBp = BP_LEFT;
        }
      }
      // N:1（A 的 k 条 ↔ B 的 1 条）
      for (let k = 2; k <= MAX_SPAN && k <= i; k++) {
        const prev = getDp(i - k, j - 1, i);
        if (isNeg(prev)) continue;
        const gs = mergeScoreA(i - k, i - 1, j - 1);
        if (isNeg(gs)) continue;
        const v = prev + gs;
        if (v > best) {
          best = v;
          bestBp = BP_MERGE_A_BASE + (k - 2);
        }
      }
      // 1:N（A 的 1 条 ↔ B 的 l 条）
      for (let l = 2; l <= MAX_SPAN && l <= j; l++) {
        const prev = getDp(i - 1, j - l, i);
        if (isNeg(prev)) continue;
        const gs = mergeScoreB(i - 1, j - l, j - 1);
        if (isNeg(gs)) continue;
        const v = prev + gs;
        if (v > best) {
          best = v;
          bestBp = BP_MERGE_B_BASE + (l - 2);
        }
      }
      row[c] = best;
      bp[i][c] = bestBp;
    }
    const cm = colOf(i, m);
    if (cm >= 0 && cm < width) colM[i] = ring[i % ROWS][cm];
  }

  // 终点选择：允许尾部作为单边片段
  let bestEnd = NEG;
  let ei = n;
  let ej = m;
  const consider = (i: number, j: number, val: number) => {
    if (val > bestEnd) {
      bestEnd = val;
      ei = i;
      ej = j;
    }
  };
  for (let j = Math.max(0, n - W); j <= Math.min(m, n + W); j++) {
    const v = ring[n % ROWS][colOf(n, j)];
    if (!isNeg(v)) consider(n, j, v + (m - j) * SKIP_PENALTY);
  }
  for (let i = Math.max(0, m - W); i <= Math.min(n, m + W); i++) {
    const v = colM[i];
    if (!isNeg(v)) consider(i, m, v + (n - i) * SKIP_PENALTY);
  }

  // 回溯移动序列
  interface Move {
    a: number[];
    b: number[];
  }
  const moves: Move[] = [];
  let ci = ei;
  let cj = ej;
  const guardMax = (n + m) * 3 + 10;
  for (let guard = 0; (ci > 0 || cj > 0) && guard < guardMax; guard++) {
    if (cj === 0) {
      moves.push({ a: [ci - 1], b: [] });
      ci--;
      continue;
    }
    if (ci === 0) {
      moves.push({ a: [], b: [cj - 1] });
      cj--;
      continue;
    }
    const move = bp[ci][colOf(ci, cj)];
    if (move === BP_UP) {
      moves.push({ a: [ci - 1], b: [] });
      ci--;
    } else if (move === BP_LEFT) {
      moves.push({ a: [], b: [cj - 1] });
      cj--;
    } else if (move === BP_DIAG) {
      moves.push({ a: [ci - 1], b: [cj - 1] });
      ci--;
      cj--;
    } else if (move >= BP_MERGE_A_BASE && move < BP_MERGE_B_BASE) {
      const k = move - BP_MERGE_A_BASE + 2;
      const a: number[] = [];
      for (let t = ci - k; t <= ci - 1; t++) a.push(t);
      moves.push({ a, b: [cj - 1] });
      ci -= k;
      cj--;
    } else {
      const l = move - BP_MERGE_B_BASE + 2;
      const b: number[] = [];
      for (let t = cj - l; t <= cj - 1; t++) b.push(t);
      moves.push({ a: [ci - 1], b });
      ci--;
      cj -= l;
    }
  }
  moves.reverse();
  // 尾部未覆盖部分作为单边片段
  for (let t = ei; t < n; t++) moves.push({ a: [t], b: [] });
  for (let t = ej; t < m; t++) moves.push({ a: [], b: [t] });

  // 折叠为组：连续的单边移动合并为一个单边组
  let pendA: number[] = [];
  let pendB: number[] = [];
  const flush = () => {
    if (pendA.length > 0) {
      groups.push(makeGroup(pendA, []));
      pendA = [];
    }
    if (pendB.length > 0) {
      groups.push(makeGroup([], pendB));
      pendB = [];
    }
  };
  for (const mv of moves) {
    if (mv.a.length > 0 && mv.b.length > 0) {
      flush();
      groups.push(makeGroup(mv.a, mv.b));
    } else if (mv.a.length > 0) {
      if (pendB.length > 0) flush();
      pendA.push(...mv.a);
    } else {
      if (pendA.length > 0) flush();
      pendB.push(...mv.b);
    }
  }
  flush();
  return groups;
}
