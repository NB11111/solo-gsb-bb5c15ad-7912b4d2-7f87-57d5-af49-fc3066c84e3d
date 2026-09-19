/** 合并决策：每组的用户选择、合并结果构建与时间单调性校验。 */
import type { AlignGroup } from './align';
import { parseTimecode, type Cue } from './srt';
import { normalizeText } from './similarity';

export type TextChoice = 'A' | 'B' | 'custom';
export type TimeChoice = 'A' | 'B' | 'union' | 'custom';

export interface Resolution {
  text: TextChoice;
  customText: string;
  time: TimeChoice;
  customStart: string;
  customEnd: string;
  /** 仅用于单边组：保留或丢弃 */
  keep: boolean;
}

export interface GroupState {
  /** 该组是否属于必须人工处理的冲突 */
  isConflict: boolean;
  /** 是否已有明确决定（自动或人工） */
  resolved: boolean;
  resolution: Resolution;
}

export function mergedText(cues: Cue[], idxs: number[]): string {
  return idxs.map((i) => cues[i].text).join('\n');
}

export function spanOf(cues: Cue[], idxs: number[]): [number, number] | null {
  if (idxs.length === 0) return null;
  let s = Infinity;
  let e = -Infinity;
  for (const i of idxs) {
    s = Math.min(s, cues[i].start);
    e = Math.max(e, cues[i].end);
  }
  return [s, e];
}

/** 建议保留的文本来源：归一化后更长（通常更完整）的一侧。 */
export function suggestTextChoice(group: AlignGroup, cuesA: Cue[], cuesB: Cue[]): TextChoice {
  const la = normalizeText(mergedText(cuesA, group.aIdx)).length;
  const lb = normalizeText(mergedText(cuesB, group.bIdx)).length;
  return la >= lb ? 'A' : 'B';
}

/** 对齐完成后为每组生成初始状态：文本一致或单边组自动解决，其余标记为待处理冲突。 */
export function defaultStateFor(group: AlignGroup, cuesA: Cue[], cuesB: Cue[]): GroupState {
  const side: 'A' | 'B' = group.kind === 'B-only' ? 'B' : 'A';
  const base: Resolution = {
    text: side,
    customText: '',
    time: side,
    customStart: '',
    customEnd: '',
    keep: true,
  };
  if (group.kind === 'A-only' || group.kind === 'B-only') {
    return { isConflict: false, resolved: true, resolution: base };
  }
  const ta = normalizeText(mergedText(cuesA, group.aIdx));
  const tb = normalizeText(mergedText(cuesB, group.bIdx));
  if (ta === tb) {
    return { isConflict: false, resolved: true, resolution: { ...base, text: 'A', time: 'A' } };
  }
  return { isConflict: true, resolved: false, resolution: { ...base, text: 'A', time: 'A' } };
}

export type IssueKind = 'time-parse' | 'time-span' | 'time-order' | 'empty-text' | 'missing-source';

export interface MergeIssue {
  kind: IssueKind;
  level: 'error';
  message: string;
  groupIndex: number;
}

export interface MergedCue {
  start: number;
  end: number;
  text: string;
  groupIndex: number;
}

/** 可通过“自动修复时间轴”消除的问题类型。 */
export const TIME_FIXABLE: IssueKind[] = ['time-order', 'time-span'];

/** 按各组决定构建合并后的 cue 序列，并校验：文本非空、时长为正、时间单调不重叠。 */
export function buildMergedCues(
  groups: AlignGroup[],
  states: GroupState[],
  cuesA: Cue[],
  cuesB: Cue[],
): { cues: MergedCue[]; issues: MergeIssue[] } {
  const cues: MergedCue[] = [];
  const issues: MergeIssue[] = [];

  groups.forEach((g, gi) => {
    const res = states[gi].resolution;
    const only = g.kind === 'A-only' || g.kind === 'B-only';
    if (only && !res.keep) return;

    let text = '';
    if (res.text === 'custom') {
      text = res.customText.trim();
    } else {
      const useA = res.text === 'A' ? g.aIdx.length > 0 : g.bIdx.length === 0;
      text = mergedText(useA ? cuesA : cuesB, useA ? g.aIdx : g.bIdx);
    }

    let start = NaN;
    let end = NaN;
    if (res.time === 'custom') {
      const s = parseTimecode(res.customStart);
      const e = parseTimecode(res.customEnd);
      if (s === null || e === null) {
        issues.push({
          kind: 'time-parse',
          level: 'error',
          message: `第 ${gi + 1} 组：自定义时间格式无效（示例 00:00:01,500）`,
          groupIndex: gi,
        });
      } else {
        start = s;
        end = e;
      }
    } else {
      const spanA = spanOf(cuesA, g.aIdx);
      const spanB = spanOf(cuesB, g.bIdx);
      let span: [number, number] | null = null;
      if (res.time === 'A') span = spanA ?? spanB;
      else if (res.time === 'B') span = spanB ?? spanA;
      else if (spanA && spanB) span = [Math.min(spanA[0], spanB[0]), Math.max(spanA[1], spanB[1])];
      else span = spanA ?? spanB;
      if (span) {
        [start, end] = span;
      } else {
        issues.push({
          kind: 'missing-source',
          level: 'error',
          message: `第 ${gi + 1} 组：没有可用的时间轴`,
          groupIndex: gi,
        });
      }
    }
    if (Number.isNaN(start) || Number.isNaN(end)) return;

    if (!text) {
      issues.push({
        kind: 'empty-text',
        level: 'error',
        message: `第 ${gi + 1} 组：合并后文本为空`,
        groupIndex: gi,
      });
    }
    if (end <= start) {
      issues.push({
        kind: 'time-span',
        level: 'error',
        message: `第 ${gi + 1} 组：结束时间必须大于开始时间`,
        groupIndex: gi,
      });
    }
    cues.push({ start, end, text, groupIndex: gi });
  });

  // 时间单调性：开始时间不得倒退，且不得与上一条重叠
  for (let i = 1; i < cues.length; i++) {
    if (cues[i].start < cues[i - 1].start) {
      issues.push({
        kind: 'time-order',
        level: 'error',
        message: `时间轴非单调：第 ${i + 1} 条开始时间早于第 ${i} 条`,
        groupIndex: cues[i].groupIndex,
      });
    } else if (cues[i].start < cues[i - 1].end) {
      issues.push({
        kind: 'time-order',
        level: 'error',
        message: `时间重叠：第 ${i + 1} 条与第 ${i} 条`,
        groupIndex: cues[i].groupIndex,
      });
    }
  }
  return { cues, issues };
}

/** 自动修复时间轴：开始时间不早于上一条结束时间，时长至少 1 秒。 */
export function autoFixTimes(cues: MergedCue[]): MergedCue[] {
  const fixed = cues.map((c) => ({ ...c }));
  for (let i = 0; i < fixed.length; i++) {
    if (i > 0 && fixed[i].start < fixed[i - 1].end) fixed[i].start = fixed[i - 1].end;
    if (fixed[i].end <= fixed[i].start) fixed[i].end = fixed[i].start + 1000;
  }
  return fixed;
}
