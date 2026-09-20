import { describe, expect, it } from 'vitest';
import type { AlignGroup } from '../align';
import {
  autoFixTimes,
  buildMergedCues,
  defaultStateFor,
  TIME_FIXABLE,
  validateCueSequence,
  type GroupState,
} from '../merge';
import { parseSrt } from '../srt';

const cuesA = parseSrt(
  '1\n00:00:01,000 --> 00:00:04,000\n甲一\n\n2\n00:00:05,000 --> 00:00:07,000\n甲二\n',
);
const cuesB = parseSrt(
  '1\n00:00:01,000 --> 00:00:03,000\n乙一\n\n2\n00:00:03,500 --> 00:00:05,500\n乙二\n',
);

function group(id: string, aIdx: number[], bIdx: number[]): AlignGroup {
  const kind =
    aIdx.length === 0
      ? ('B-only' as const)
      : bIdx.length === 0
        ? ('A-only' as const)
        : aIdx.length === 1 && bIdx.length === 1
          ? ('1:1' as const)
          : aIdx.length > 1
            ? ('N:1' as const)
            : ('1:N' as const);
  return { id, aIdx, bIdx, kind, textSim: 0, timeOverlap: 0, confidence: 0 };
}

function resolved(patch: Partial<GroupState['resolution']> = {}): GroupState {
  return {
    isConflict: true,
    resolved: true,
    resolution: {
      text: 'A',
      customText: '',
      time: 'A',
      customStart: '',
      customEnd: '',
      keep: true,
      ...patch,
    },
  };
}

describe('defaultStateFor', () => {
  it('文本一致自动解决，文本不同标记为冲突', () => {
    const same = group('g0', [0], [0]);
    const a = parseSrt('1\n00:00:01,000 --> 00:00:02,000\n相同文本\n');
    const b = parseSrt('1\n00:00:01,000 --> 00:00:02,000\n相同文本！\n');
    expect(defaultStateFor(same, a, b).resolved).toBe(true);
    const diff = group('g1', [0], [0]);
    expect(defaultStateFor(diff, cuesA, cuesB).isConflict).toBe(true);
    expect(defaultStateFor(diff, cuesA, cuesB).resolved).toBe(false);
  });
});

describe('buildMergedCues', () => {
  it('按决定取文本与时间轴', () => {
    const groups = [group('g0', [0], [0]), group('g1', [1], [1])];
    const states = [resolved({ text: 'B', time: 'B' }), resolved({ text: 'A', time: 'union' })];
    const { cues, issues } = buildMergedCues(groups, states, cuesA, cuesB);
    expect(issues).toHaveLength(0);
    expect(cues[0]).toMatchObject({ start: 1000, end: 3000, text: '乙一' });
    expect(cues[1]).toMatchObject({ start: 3500, end: 7000, text: '甲二' });
  });

  it('检测时间重叠并支持自动修复', () => {
    const groups = [group('g0', [0], [0]), group('g1', [1], [1])];
    const states = [resolved({ time: 'A' }), resolved({ time: 'B' })]; // 3500 < 4000 重叠
    const { cues, issues } = buildMergedCues(groups, states, cuesA, cuesB);
    expect(issues.some((i) => i.kind === 'time-order')).toBe(true);
    const fixed = autoFixTimes(cues);
    expect(fixed[1].start).toBe(fixed[0].end);
    const again = buildMergedCues(groups, states, cuesA, cuesB);
    expect(TIME_FIXABLE).toContain('time-order');
    expect(again.issues.filter((i) => i.kind === 'time-order')).toHaveLength(1);
  });

  it('丢弃的单边组不进入结果', () => {
    const groups = [group('g0', [0], []), group('g1', [1], [1])];
    const states = [resolved({ keep: false }), resolved()];
    const { cues } = buildMergedCues(groups, states, cuesA, cuesB);
    expect(cues).toHaveLength(1);
    expect(cues[0].text).toBe('甲二');
  });

  it('自定义时间非法时报错', () => {
    const groups = [group('g0', [0], [0])];
    const states = [resolved({ time: 'custom', customStart: 'bad', customEnd: '00:00:02,000' })];
    const { issues } = buildMergedCues(groups, states, cuesA, cuesB);
    expect(issues.some((i) => i.kind === 'time-parse')).toBe(true);
  });
});

describe('validateCueSequence（消重后序列复核）', () => {
  const c = (start: number, end: number, text: string, groupIndex: number) => ({
    start,
    end,
    text,
    groupIndex,
  });

  it('正常序列无问题', () => {
    const issues = validateCueSequence([c(0, 1000, '甲', 0), c(1000, 2000, '乙', 1)]);
    expect(issues).toHaveLength(0);
  });

  it('识别空文本、时长非正、倒退与重叠', () => {
    const issues = validateCueSequence([
      c(0, 1000, '', 0), // empty-text
      c(2000, 2000, 'x', 1), // time-span
      c(1500, 3000, 'y', 2), // 倒退 time-order
      c(2500, 4000, 'z', 3), // 重叠 time-order
    ]);
    expect(issues.map((i) => i.kind)).toEqual([
      'empty-text',
      'time-span',
      'time-order',
      'time-order',
    ]);
    // time-order / time-span 均可被自动修复覆盖
    for (const k of ['time-order', 'time-span'] as const) expect(TIME_FIXABLE).toContain(k);
  });
});
