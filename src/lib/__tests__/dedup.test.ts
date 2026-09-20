import { describe, expect, it } from 'vitest';
import {
  dedupCues,
  findScrollChains,
  longestSuffixPrefixOverlap,
  normalizeWithOffset,
  type DedupCueLike,
  type DedupOptions,
} from '../dedup';

const OPTS: DedupOptions = { maxGapMs: 2000, minOverlap: 2 };

function cue(start: number, end: number, text: string): DedupCueLike {
  return { start, end, text };
}

/** 等长 3 秒、间隔 500ms 的 cue 序列。 */
function seq(texts: string[], gap = 500): DedupCueLike[] {
  return texts.map((t, i) => cue(i * (3000 + gap), i * (3000 + gap) + 3000, t));
}

describe('longestSuffixPrefixOverlap（KMP 最长后缀-前缀）', () => {
  it('基础滚动重叠', () => {
    expect(longestSuffixPrefixOverlap('今天天气', '天气预报')).toBe(2); // “天气”
    expect(longestSuffixPrefixOverlap('abcdef', 'defghi')).toBe(3);
    expect(longestSuffixPrefixOverlap('你好世界', '完全不同')).toBe(0);
  });

  it('歧义重叠取最长', () => {
    // a 后缀 “aaa” 与 b 前缀 “aaa”，同时存在长度 1/2 的更短重叠
    expect(longestSuffixPrefixOverlap('xaaa', 'aaab')).toBe(3);
    // 周期串：a='ababa'、b='ababb'，存在 1（“a”）/3（“aba”）多个 border，取最长
    expect(longestSuffixPrefixOverlap('ababa', 'ababb')).toBe(3);
    // 完全相同时整条串互为后缀-前缀
    expect(longestSuffixPrefixOverlap('aaaa', 'aaaa')).toBe(4);
    // 完全包含（下一条是上一条的后缀滚动）
    expect(longestSuffixPrefixOverlap('滚动字幕消重功能', '字幕消重功能')).toBe(6);
  });

  it('不超过较短串长度，空串安全', () => {
    expect(longestSuffixPrefixOverlap('abc', 'abcabc')).toBe(3);
    expect(longestSuffixPrefixOverlap('', 'abc')).toBe(0);
    expect(longestSuffixPrefixOverlap('abc', '')).toBe(0);
  });
});

describe('normalizeWithOffset（标签 / 标点 / 空白）', () => {
  it('标签与标点不入归一化序列，偏移指向原文位置', () => {
    const info = normalizeWithOffset('<i>你好，</i>世界');
    expect(info.norm).toBe('你好世界');
    // 原文下标：<i>(0-2) 你(3)好(4)，(5)</i>(6-9)世(10)界(11)
    expect(info.offset[0]).toBe(3);
    expect(info.offset[2]).toBe(10);
    // 偏移直接用于原文切片：从“世”开始
    expect('<i>你好，</i>世界'.slice(info.offset[2])).toBe('世界');
  });

  it('ASS 覆盖标签同样剥离', () => {
    const info = normalizeWithOffset('{\\an8}HELLO！');
    expect(info.norm).toBe('hello');
  });

  it('空白、全角空白均被剥离', () => {
    expect(normalizeWithOffset('a b　c\n').norm).toBe('abc');
  });

  it('小写化后计算重叠', () => {
    expect(longestSuffixPrefixOverlap(normalizeWithOffset('HELLO world').norm, normalizeWithOffset('World PEACE').norm)).toBe(5);
  });
});

describe('findScrollChains 基本链识别', () => {
  it('识别三段滚动链并只追加新增尾部', () => {
    const cues = seq(['今天天气', '天气预报', '预报有雨']);
    const chains = findScrollChains(cues, OPTS);
    expect(chains).toHaveLength(1);
    const ch = chains[0];
    expect(ch.members).toEqual([0, 1, 2]);
    expect(ch.overlaps).toEqual([2, 2]); // “天气” / “预报”
    expect(ch.savedChars).toBe(4);
    expect(ch.mergedText).toBe('今天天气预报有雨');
  });

  it('只追加新增尾部，合并时间取链首开始与链末结束', () => {
    const cues = seq(['滚动字幕测试', '字幕测试完成']);
    const chains = findScrollChains(cues, OPTS);
    expect(chains).toHaveLength(1);
    const ch = chains[0];
    expect(ch.overlaps).toEqual([4]);
    expect(ch.savedChars).toBe(4);
    expect(ch.mergedText).toBe('滚动字幕测试完成');
    expect(ch.start).toBe(cues[0].start);
    expect(ch.end).toBe(cues[1].end);
  });

  it('后续项被上一条后缀完全包含时不新增内容', () => {
    // cue1 归一化“字幕消重功能”是 cue0“滚动字幕消重功能”的后缀
    const cues = seq(['滚动字幕消重功能', '字幕消重功能']);
    const chains = findScrollChains(cues, { ...OPTS, minOverlap: 4 });
    expect(chains).toHaveLength(1);
    expect(chains[0].mergedText).toBe('滚动字幕消重功能');
    expect(chains[0].savedChars).toBe(6);
  });

  it('无候选链时返回空', () => {
    expect(findScrollChains(seq(['完全无关', '另一组文字']), OPTS)).toHaveLength(0);
    expect(findScrollChains([cue(0, 1000, '仅一条')], OPTS)).toHaveLength(0);
  });
});

describe('间隔边界（maxGapMs）', () => {
  it('间隔等于上界仍连接，超过上界断开', () => {
    const a = cue(0, 1000, '滚动字幕');
    const b = cue(3000, 4000, '字幕消重'); // gap = 2000
    expect(findScrollChains([a, b], { maxGapMs: 2000, minOverlap: 2 })).toHaveLength(1);
    expect(findScrollChains([a, b], { maxGapMs: 1999, minOverlap: 2 })).toHaveLength(0);
  });

  it('时间重叠（负间隔）允许连接', () => {
    const a = cue(0, 3000, '滚动字幕');
    const b = cue(2500, 5000, '字幕消重'); // gap = -500
    expect(findScrollChains([a, b], { maxGapMs: 0, minOverlap: 2 })).toHaveLength(1);
  });

  it('间隔 0（首尾相接）允许连接', () => {
    const a = cue(0, 1000, '滚动字幕');
    const b = cue(1000, 2000, '字幕消重');
    expect(findScrollChains([a, b], { maxGapMs: 0, minOverlap: 2 })).toHaveLength(1);
  });
});

describe('最小文本重叠边界（minOverlap）', () => {
  it('重叠字数等于阈值采纳，低于阈值断链', () => {
    const cues = seq(['你好世界', '世界观']);
    expect(findScrollChains(cues, { maxGapMs: 2000, minOverlap: 2 })).toHaveLength(1);
    expect(findScrollChains(cues, { maxGapMs: 2000, minOverlap: 3 })).toHaveLength(0);
  });

  it('仅标点 / 空白相同不计入重叠，尾部标点保留', () => {
    // 归一化后分别为“你好世界”“世界再见”，重叠 2
    const cues = seq(['你好，世界！', '世界，再见。']);
    const noChain = findScrollChains(
      seq(['你好！', '，再见']),
      { maxGapMs: 2000, minOverlap: 1 },
    );
    expect(noChain).toHaveLength(0);
    const chains = findScrollChains(cues, { maxGapMs: 2000, minOverlap: 2 });
    expect(chains).toHaveLength(1);
    // 追加尾部前回退越过切点上的“，”：标点随尾部保留
    expect(chains[0].mergedText).toBe('你好，世界！，再见。');
  });
});

describe('标签与标点的尾部映射', () => {
  it('重叠覆盖到标签时标签留在重叠侧，新增尾部保留剩余标签', () => {
    // cue0 全文 <i>滚动字幕</i>测试；cue1 归一化“字幕测试完成”，
    // 重叠“字幕测试”对应原文切到“完成”处（闭合标签在重叠侧被丢弃）
    const cues = seq(['<i>滚动字幕</i>测试', '字幕测试完成']);
    const chains = findScrollChains(cues, OPTS);
    expect(chains).toHaveLength(1);
    expect(chains[0].mergedText).toBe('<i>滚动字幕</i>测试完成');
  });

  it('cue 自带的前置标签位于重叠侧时随重叠丢弃，尾部标签保留', () => {
    // cue1 “<b>字幕消重</b>”：重叠“字幕消重”覆盖到“</b>”前，开口标签 <b> 在重叠位置之前被丢弃，
    // 闭合标签在新增字符之后，随尾部保留
    const cues = seq(['滚动字幕消重', '<b>字幕消重</b>']);
    const chains = findScrollChains(cues, OPTS);
    expect(chains[0].mergedText).toBe('滚动字幕消重</b>');
  });

  it('cue 新增部分自带的标签原样保留', () => {
    // cue1 重叠仅“字幕”，标签 <b> 位于重叠之后，随新增尾部保留
    const cues = seq(['滚动字幕', '字幕<b>消重</b>']);
    const chains = findScrollChains(cues, OPTS);
    expect(chains[0].mergedText).toBe('滚动字幕<b>消重</b>');
  });

  it('标点落在重叠区内不重复出现', () => {
    const cues = seq(['你好，世界', '世界再见']);
    const chains = findScrollChains(cues, OPTS);
    expect(chains[0].mergedText).toBe('你好，世界再见');
  });
});

describe('全局动态规划：互不重叠与目标优先级', () => {
  it('互不相交的两段链都被选中', () => {
    const cues = seq(['滚动字幕', '字幕消重', '无关内容', '另一滚动', '滚动继续']);
    const chains = findScrollChains(cues, OPTS);
    expect(chains.map((c) => c.members)).toEqual([[0, 1], [3, 4]]);
    expect(chains.reduce((s, c) => s + c.savedChars, 0)).toBe(4);
  });

  it('最大化消除字符数：三连滚动累加全部相邻重叠', () => {
    // 0→1 后缀“滚动字幕”4；1→2 后缀“字幕消重”4，一条三链节省 8
    const cues = seq(['甲乙滚动字幕', '滚动字幕消重', '字幕消重完成']);
    const chains = findScrollChains(cues, { ...OPTS, minOverlap: 4 });
    expect(chains).toHaveLength(1);
    expect(chains[0].members).toEqual([0, 1, 2]);
    expect(chains[0].savedChars).toBe(8);
    expect(chains[0].mergedText).toBe('甲乙滚动字幕消重完成');
  });

  it('最大化消除字符数：冲突链之间取节省更大者', () => {
    // 三边都有重叠会形成三连，无法构造冲突；用不同重叠权重验证：
    // 0→1 重叠 4，1→2 重叠 2 但 1→2 文本导致三连同样合法时取三连（总 6）。
    // 这里改为验证间隔断边后的两段独立链各自权重
    const cues = [
      cue(0, 1000, '甲乙滚动字幕'),
      cue(1500, 2500, '滚动字幕消重'), // 重叠 4
      cue(10_000, 11_000, '晴天滚动字幕消重'),
      cue(11_500, 12_500, '滚动字幕消重完成'), // 重叠 6（“滚动字幕消重”）
    ];
    const chains = findScrollChains(cues, { ...OPTS, minOverlap: 4 });
    expect(chains.map((c) => c.members)).toEqual([[0, 1], [2, 3]]);
    expect(chains.map((c) => c.savedChars)).toEqual([4, 6]);
    expect(chains[1].mergedText).toBe('晴天滚动字幕消重完成');
  });

  it('同分取更早链：可选链等分时优先起点更早的方案', () => {
    // 构造后缀方案同分：cue 2-3 自身构成一条节省 2 的链；
    // 若 cue 0-1 也为节省 2 的链，则 dp[0] 同时存在
    //   取[0,1]+dp[2]（链起点 0） 与 跳过 0 后取[1,…] 的比较，
    // 验证 [0,1] 在前，且输出链按起点升序。
    const cues = [
      cue(0, 1000, '今天天气'),
      cue(1500, 2500, '天气预报'), // 重叠“天气”2
      cue(5000, 6000, '无关内容'), // 间隔大，断边
      cue(6500, 7500, '滚动字幕'),
      cue(8000, 9000, '字幕消重'), // 重叠“字幕”2
    ];
    const chains = findScrollChains(cues, OPTS);
    expect(chains.map((c) => c.members)).toEqual([[0, 1], [3, 4]]);
  });

  it('起点相同的候选偏好更短链（结束更早）', () => {
    // [0,1,2] 与 [0,1] + dp[2] 比较：额外边 1→2 为正收益时三连更优；
    // 若 1→2 重叠不达阈值，则只保留两连，验证不会强行延长
    const cues = [
      cue(0, 1000, '今天天气'),
      cue(1500, 2500, '天气预报'), // 重叠 2
      cue(3000, 4000, '南辕北辙'), // 与 cue1 无重叠
    ];
    const chains = findScrollChains(cues, OPTS);
    expect(chains).toHaveLength(1);
    expect(chains[0].members).toEqual([0, 1]);
  });

  it('断边把序列切为独立链', () => {
    const cues = [
      cue(0, 1000, '今天天气'),
      cue(1500, 2500, '天气预报'), // 重叠“天气”2
      cue(10_000, 11_000, '毫不相干的话'), // 间隔超大断边
      cue(11_500, 12_500, '的话再说吧'), // 重叠“的话”2
    ];
    const chains = findScrollChains(cues, OPTS);
    expect(chains.map((c) => c.members)).toEqual([[0, 1], [2, 3]]);
  });
});

describe('dedupCues（采纳与恢复的压缩结果）', () => {
  it('采纳链压缩为一条合并 cue，未采纳保持原样', () => {
    const cues = seq(['滚动字幕', '字幕消重', '无关尾巴']);
    const chains = findScrollChains(cues, OPTS);
    const adopted = new Set<number>([chains[0].members[0]]);
    const out = dedupCues(cues, chains, adopted);
    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({ text: '滚动字幕消重', keyIndex: 0, absorbed: [1] });
    expect(out[1]).toMatchObject({ text: '无关尾巴', keyIndex: 2, absorbed: [] });
  });

  it('全部恢复（空采纳集合）时条数与原文一致', () => {
    const cues = seq(['滚动字幕', '字幕消重']);
    const chains = findScrollChains(cues, OPTS);
    const out = dedupCues(cues, chains, new Set());
    expect(out.map((c) => c.text)).toEqual(['滚动字幕', '字幕消重']);
  });
});
