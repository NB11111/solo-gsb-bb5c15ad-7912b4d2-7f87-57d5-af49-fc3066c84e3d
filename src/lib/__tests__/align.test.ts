import { describe, expect, it } from 'vitest';
import { alignCues } from '../align';
import { SAMPLE_A, SAMPLE_B } from '../samples';
import { parseSrt } from '../srt';

describe('alignCues', () => {
  it('完全相同的两个版本全部 1:1 且置信度为 1', () => {
    const cues = parseSrt(SAMPLE_A);
    const groups = alignCues(cues, cues);
    expect(groups).toHaveLength(cues.length);
    for (const g of groups) {
      expect(g.kind).toBe('1:1');
      expect(g.confidence).toBeCloseTo(1, 5);
    }
  });

  it('示例数据能识别 1:1 / 1:N / N:1 / 仅A / 仅B', () => {
    const groups = alignCues(parseSrt(SAMPLE_A), parseSrt(SAMPLE_B));
    const kinds = new Set(groups.map((g) => g.kind));
    expect(kinds.has('1:1')).toBe(true);
    expect(kinds.has('1:N')).toBe(true);
    expect(kinds.has('N:1')).toBe(true);
    expect(kinds.has('A-only')).toBe(true);
    expect(kinds.has('B-only')).toBe(true);
    // 每个输入 cue 恰好被覆盖一次
    const aCovered = groups.flatMap((g) => g.aIdx).sort((x, y) => x - y);
    const bCovered = groups.flatMap((g) => g.bIdx).sort((x, y) => x - y);
    expect(aCovered).toEqual([...Array(12).keys()]);
    expect(bCovered).toEqual([...Array(11).keys()]);
    // 组保持顺序单调
    for (let i = 1; i < groups.length; i++) {
      const prevA = groups[i - 1].aIdx.length ? groups[i - 1].aIdx[groups[i - 1].aIdx.length - 1] : -1;
      const curA = groups[i].aIdx.length ? groups[i].aIdx[0] : Infinity;
      const prevB = groups[i - 1].bIdx.length ? groups[i - 1].bIdx[groups[i - 1].bIdx.length - 1] : -1;
      const curB = groups[i].bIdx.length ? groups[i].bIdx[0] : Infinity;
      expect(curA).toBeGreaterThan(prevA);
      expect(curB).toBeGreaterThan(prevB);
    }
  });

  it('空输入安全', () => {
    expect(alignCues([], [])).toEqual([]);
    expect(alignCues(parseSrt(SAMPLE_A), [])).toHaveLength(1);
    expect(alignCues([], parseSrt(SAMPLE_B))[0].kind).toBe('B-only');
  });

  it('拆分的一对多被识别', () => {
    const a = parseSrt('1\n00:00:01,000 --> 00:00:04,000\n你好世界，今天天气真不错\n');
    const b = parseSrt(
      '1\n00:00:01,000 --> 00:00:02,000\n你好世界\n\n2\n00:00:02,000 --> 00:00:04,000\n今天天气真不错\n',
    );
    const groups = alignCues(a, b);
    expect(groups).toHaveLength(1);
    expect(groups[0].kind).toBe('1:N');
    expect(groups[0].bIdx).toEqual([0, 1]);
  });
});
