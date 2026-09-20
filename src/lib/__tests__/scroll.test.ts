import { describe, expect, it } from 'vitest';
import type { MergedCue } from '../merge';
import {
  applyScrollChains,
  findScrollChains,
  overlapSequence,
  suffixPrefixOverlap,
} from '../scroll';

function cue(
  start: number,
  end: number,
  text: string,
  groupIndex: number,
): MergedCue {
  return { start, end, text, groupIndex };
}

/** 生成时间连续（默认间隔 100ms）的 cue 列表。 */
function cuesOf(texts: string[], gap = 100, dur = 2000): MergedCue[] {
  return texts.map((t, i) => {
    const start = i * (dur + gap);
    return cue(start, start + dur, t, i);
  });
}

const OPTS = { maxGapMs: 1000, minOverlap: 2 };

describe('overlapSequence', () => {
  it('去除 HTML 与 ASS 标签、标点、空白，保留大小写', () => {
    expect(overlapSequence('<i>Hello, World!</i>')).toBe('HelloWorld');
    expect(overlapSequence('{\\an8}你好， 世界！')).toBe('你好世界');
    expect(overlapSequence('A\nb\tC')).toBe('AbC');
  });
});

describe('suffixPrefixOverlap 歧义重叠', () => {
  it('取最长后缀-前缀重叠，而非任意子串重叠', () => {
    // b 的前缀 "abc" 出现在 a 中间，但后缀匹配只有 "bc"
    const a = [...'xabc'];
    const b = [...'bcde'];
    expect(suffixPrefixOverlap(a, b)).toBe(2);
    expect(suffixPrefixOverlap([...'abc'], [...'abc'])).toBe(3);
  });

  it('周期串取最长且不超过较短序列长度', () => {
    // a="xabab" 后缀与 b="ababxx" 前缀最长重叠 4
    expect(suffixPrefixOverlap([...'xabab'], [...'ababxx'])).toBe(4);
    // "ababa" 后缀 vs "ababxx" 前缀：最长为 "aba"（"ababx" 并非 a 后缀）
    expect(suffixPrefixOverlap([...'ababa'], [...'ababxx'])).toBe(3);
    // a 全程包含 b 时重叠为 b 的全长（匹配在 a 末尾）
    expect(suffixPrefixOverlap([...'xxxabc'], [...'abc'])).toBe(3);
    // b 在 a 中完整出现两次但第二次恰好在末尾
    expect(suffixPrefixOverlap([...'abcabc'], [...'abc'])).toBe(3);
  });

  it('b 整体是 a 末尾前缀（a 更长）', () => {
    expect(suffixPrefixOverlap([...'helloworld'], [...'world'])).toBe(5);
  });

  it('大小写不一致不视为重叠', () => {
    expect(suffixPrefixOverlap([...'helloABC'], [...'ABCdef'])).toBe(3);
    expect(suffixPrefixOverlap([...'helloabc'], [...'ABCdef'])).toBe(0);
  });

  it('按码点处理，emoji 不拆代理对', () => {
    expect(suffixPrefixOverlap([...'你好👍'], [...'👍世界'])).toBe(1);
  });
});

describe('标签 / 标点 / 空白文本', () => {
  it('标签不参与重叠，新增尾部按原文位置原样切取', () => {
    const cues = cuesOf(['<i>你好世界</i>', '<i>世界你好</i>']);
    const chains = findScrollChains(cues, OPTS);
    expect(chains).toHaveLength(1);
    expect(chains[0].saved).toBe(2); // “世界”
    expect(chains[0].text).toBe('<i>你好世界</i>你好</i>');
  });

  it('标点与空白不参与重叠但保留在合并文本中', () => {
    const cues = cuesOf(['你好，世界！', '世界！再见。']);
    const chains = findScrollChains(cues, OPTS);
    expect(chains).toHaveLength(1);
    // 重叠口径为去标点后的“世界”（2 字），尾部从“世”开始，标点随之保留
    expect(chains[0].saved).toBe(2);
    expect(chains[0].text).toBe('你好，世界！再见。');
  });

  it('仅标点/空白差异也可连接（尾部不重复追加）', () => {
    const cues = cuesOf(['你好世界！', '你好世界']);
    const chains = findScrollChains(cues, OPTS);
    expect(chains).toHaveLength(1);
    expect(chains[0].text).toBe('你好世界！');
    expect(chains[0].saved).toBe(4);
  });

  it('ASS 覆盖标签不参与重叠', () => {
    const cues = cuesOf(['{\\an8}滚动字幕', '{\\an8}字幕消重']);
    const chains = findScrollChains(cues, OPTS);
    expect(chains).toHaveLength(1);
    expect(chains[0].saved).toBe(2);
  });
});

describe('相邻间隔边界', () => {
  it('间隔恰等于 maxGapMs 时可连接（闭区间）', () => {
    const c = [cue(0, 1000, '你好世界', 0), cue(2000, 3000, '世界你好', 1)];
    expect(findScrollChains(c, { maxGapMs: 1000, minOverlap: 2 })).toHaveLength(1);
  });

  it('间隔超出 maxGapMs 时不连接', () => {
    const c = [cue(0, 1000, '你好世界', 0), cue(2001, 3000, '世界你好', 1)];
    expect(findScrollChains(c, { maxGapMs: 1000, minOverlap: 2 })).toHaveLength(0);
  });

  it('时间重叠（负间隔）允许连接', () => {
    const c = [cue(0, 2000, '你好世界', 0), cue(1500, 3000, '世界你好', 1)];
    expect(findScrollChains(c, OPTS)).toHaveLength(1);
  });

  it('间隔为 0（首尾相接）允许连接', () => {
    const c = [cue(0, 1000, '你好世界', 0), cue(1000, 2000, '世界你好', 1)];
    expect(findScrollChains(c, { maxGapMs: 0, minOverlap: 2 })).toHaveLength(1);
  });

  it('开始时间倒退不连接', () => {
    const c = [cue(1000, 3000, '你好世界', 0), cue(500, 2500, '世界你好', 1)];
    expect(findScrollChains(c, OPTS)).toHaveLength(0);
  });
});

describe('最小文本重叠边界', () => {
  it('重叠恰达到 minOverlap 时连接', () => {
    const cues = cuesOf(['你好世界', '世界再见']);
    expect(findScrollChains(cues, { maxGapMs: 1000, minOverlap: 2 })).toHaveLength(1);
  });

  it('重叠不足 minOverlap 时不连接', () => {
    const cues = cuesOf(['甲乙丙', '丙丁']);
    expect(findScrollChains(cues, { maxGapMs: 1000, minOverlap: 2 })).toHaveLength(0);
    expect(findScrollChains(cues, { maxGapMs: 1000, minOverlap: 1 })).toHaveLength(1);
  });
});

describe('连续滚动链', () => {
  it('多条逐级滚动合并为一条链，只追加新增尾部', () => {
    const cues = cuesOf(['今天天气很好', '天气很好适合', '很好适合出门']);
    const chains = findScrollChains(cues, OPTS);
    expect(chains).toHaveLength(1);
    const ch = chains[0];
    expect(ch.members).toEqual([0, 1, 2]);
    expect(ch.start).toBe(0);
    expect(ch.end).toBe(cues[2].end);
    expect(ch.text).toBe('今天天气很好适合出门');
    expect(ch.saved).toBe(4 + 4); // “天气很好” + “很好适合”
    expect(ch.edges).toEqual([
      { overlap: 4, tailStart: 4 },
      { overlap: 4, tailStart: 4 },
    ]);
  });

  it('间隔断点把滚动分成两条独立链', () => {
    const c = [
      cue(0, 2000, '你好世界', 0),
      cue(2050, 4000, '世界你好', 1),
      // 与前一条间隔 500ms（超过 maxGap=50），与后一条间隔 50ms
      cue(4500, 6000, '再见朋友', 2),
      cue(6050, 8000, '朋友再见', 3),
    ];
    const chains = findScrollChains(c, { maxGapMs: 50, minOverlap: 2 });
    expect(chains).toHaveLength(2);
    expect(chains[0].members).toEqual([0, 1]);
    expect(chains[1].members).toEqual([2, 3]);
  });
});

describe('全局动态规划', () => {
  it('正权边冲突时最大化总消除字符：延伸链始终优于在内部断开', () => {
    // 三段连续滚动，若拆成 [0,1]+[2] 得 2，整条 [0,1,2] 得 2+3=5
    const c = cuesOf(['你好世界', '世界！xyz', 'xyzworld']);
    // 0→1：“世界”=2；1 归一化 “世界xyz”，2 “xyzworld”：后缀 “xyz”=3
    const chains = findScrollChains(c, OPTS);
    expect(chains).toHaveLength(1);
    expect(chains[0].members).toEqual([0, 1, 2]);
    expect(chains[0].saved).toBe(5);
  });

  it('零权边不参与连接：最小重叠为 1 时仅真实重叠边入链', () => {
    const c = cuesOf(['你好世界', '世界晴天', '完全不同']);
    // 0→1 重叠 2；1→2 无重叠；minOverlap 1 时也不应桥接
    const chains = findScrollChains(c, { maxGapMs: 1000, minOverlap: 1 });
    expect(chains).toHaveLength(1);
    expect(chains[0].members).toEqual([0, 1]);
  });

  it('最小化合并组数：零权边允许桥接为一条链（minOverlap=0）', () => {
    // 0→1 重叠，1→2 无重叠，2→3 重叠：整条 1 组优于两段 2 组
    const c = cuesOf(['你好世界', '世界晴天', '完全不同', '不同结局'], 100);
    const chains = findScrollChains(c, { maxGapMs: 1000, minOverlap: 0 });
    expect(chains).toHaveLength(1);
    expect(chains[0].members).toEqual([0, 1, 2, 3]);
    expect(chains[0].saved).toBe(4); // 2 + 0 + 2
  });

  it('同分取更早链：输出按链首下标升序，起始最早的可行链优先', () => {
    // 边 0→1 与 2→3 各权重 1、中间被大间隔断开：两条链同 w 同组数，
    // 结果中首条链必须是链首更早的 [0,1]（由 DP 回溯的“取链优先于跳过”
    // 以及链区间字典序比较保证）。
    const c = [
      cue(0, 2000, '甲乙', 0),
      cue(2100, 4000, '乙丙', 1), // 与 0 间隔 100ms，重叠“乙”1 字
      cue(5000, 7000, '丙丁', 2), // 与 1 间隔 1000ms，超过 maxGap=500，断开
      cue(7100, 9000, '丁戊', 3), // 与 2 间隔 100ms，重叠“丁”1 字
    ];
    const chains = findScrollChains(c, { maxGapMs: 500, minOverlap: 1 });
    expect(chains).toHaveLength(2);
    expect(chains[0].members).toEqual([0, 1]);
    expect(chains[1].members).toEqual([2, 3]);
    expect(chains[0].saved).toBe(1);
    expect(chains[1].saved).toBe(1);

    // 首条 cue 不可连接时，链从最早可连接位置开始（不被“跳过”方案误提前）
    const c2 = cuesOf(['无关', '甲乙', '乙丙', '丙丁'], 100);
    // 0→1 无重叠断开；1→2 “乙”=1，2→3 “丙”=1 连续延伸为 [1,2,3]
    const chains2 = findScrollChains(c2, { maxGapMs: 1000, minOverlap: 1 });
    expect(chains2).toHaveLength(1);
    expect(chains2[0].members).toEqual([1, 2, 3]);
  });

  it('正权边组成的最大连通段天然为一组（不做无收益切分）', () => {
    const cues = cuesOf(['甲乙丙丁', '丙丁戊己', '戊己庚辛']);
    const chains = findScrollChains(cues, OPTS);
    expect(chains).toHaveLength(1);
    expect(chains[0].members).toEqual([0, 1, 2]);
  });
});

describe('applyScrollChains', () => {
  it('按采纳链折叠：时间取链首开始、末条结束，groupIndex 取首条', () => {
    const cues = cuesOf(['你好世界', '世界你好', '你好再见']);
    const chains = findScrollChains(cues, OPTS);
    expect(chains).toHaveLength(1);
    const out = applyScrollChains(cues, chains, new Set([chains[0].key]));
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      start: 0,
      end: cues[2].end,
      text: '你好世界你好再见',
      groupIndex: 0,
    });
  });

  it('未采纳时原样保留全部 cue', () => {
    const cues = cuesOf(['你好世界', '世界你好']);
    const chains = findScrollChains(cues, OPTS);
    const out = applyScrollChains(cues, chains, new Set());
    expect(out).toEqual(cues);
  });

  it('部分采纳：未涉及的 cue 原样保留', () => {
    const c = [
      cue(0, 2000, '你好世界', 0),
      cue(2050, 4000, '世界你好', 1),
      cue(4500, 6000, '再见朋友', 2),
      cue(6050, 8000, '朋友再见', 3),
    ];
    const chains = findScrollChains(c, { maxGapMs: 50, minOverlap: 2 });
    expect(chains).toHaveLength(2);
    const out = applyScrollChains(c, chains, new Set([chains[1].key]));
    expect(out).toHaveLength(3);
    expect(out[0]).toBe(c[0]);
    expect(out[1]).toBe(c[1]);
    expect(out[2]).toMatchObject({ start: 4500, end: 8000, groupIndex: 2 });
  });

  it('已失效（当前参数下不存在）的 key 被忽略', () => {
    const cues = cuesOf(['你好世界', '世界你好']);
    const chains = findScrollChains(cues, OPTS);
    const out = applyScrollChains(cues, chains, new Set(['stale-key']));
    expect(out).toEqual(cues);
    // 真实 key 仍可工作
    const out2 = applyScrollChains(cues, chains, new Set(['stale-key', chains[0].key]));
    expect(out2).toHaveLength(1);
  });

  it('空输入与单条 cue 安全处理', () => {
    expect(findScrollChains([], OPTS)).toEqual([]);
    const one = cuesOf(['只有一条']);
    expect(findScrollChains(one, OPTS)).toEqual([]);
    expect(applyScrollChains(one, [], new Set())).toEqual(one);
  });
});
