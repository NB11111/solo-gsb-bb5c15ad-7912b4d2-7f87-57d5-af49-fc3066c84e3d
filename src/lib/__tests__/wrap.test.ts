import { describe, expect, it } from 'vitest';
import {
  BAD_LINE_END_CHARS,
  BAD_LINE_START_CHARS,
  displayWidth,
  smartWrap,
  type WrapOptions,
} from '../wrap';

const OPTS: WrapOptions = { maxWidth: 10, maxLines: 3, lockManualBreaks: true };
const wrap = (text: string, patch: Partial<WrapOptions> = {}) => smartWrap(text, { ...OPTS, ...patch });

describe('displayWidth', () => {
  it('全角计 2、半角计 1', () => {
    expect(displayWidth('abc')).toBe(3);
    expect(displayWidth('你好')).toBe(4);
    expect(displayWidth('a你b')).toBe(4);
    expect(displayWidth('，。！？')).toBe(8);
  });

  it('HTML/ASS 标签不计宽', () => {
    expect(displayWidth('<i>你好</i>')).toBe(4);
    expect(displayWidth('<font color="#fff">a</font>')).toBe(1);
    expect(displayWidth('{\\an8}{\\pos(10,20)}你好')).toBe(4);
  });

  it('字素簇不可拆分：组合符、emoji', () => {
    expect(displayWidth('é')).toBe(1); // e + 组合符
    expect(displayWidth('👍')).toBe(2);
    expect(displayWidth('a👍b')).toBe(4);
    expect(displayWidth('👨‍👩‍👧')).toBe(2); // ZWJ 序列算一个簇
  });
});

describe('smartWrap 基本行为', () => {
  it('未超宽时保持原文', () => {
    const r = wrap('你好世界', { maxWidth: 8 });
    expect(r).toMatchObject({ ok: true, changed: false, lines: ['你好世界'] });
  });

  it('英文在空白处断行并保持行宽均衡', () => {
    const r = wrap('aa bb cc dd', { maxWidth: 5 });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.lines).toEqual(['aa bb', 'cc dd']);
      expect(r.widths).toEqual([5, 5]);
    }
  });

  it('断行消耗断点处空白，行首行尾不留空格', () => {
    const r = wrap('aa  bb', { maxWidth: 3 });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.lines).toEqual(['aa', 'bb']);
  });

  it('行数不超过最多行数', () => {
    const r = wrap('aa bb cc dd ee', { maxWidth: 5, maxLines: 3 });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.lines.length).toBeLessThanOrEqual(3);
      expect(r.widths.every((w) => w <= 5)).toBe(true);
      expect(r.text.replace(/\n/g, ' ')).toBe('aa bb cc dd ee');
    }
  });

  it('空文本安全返回', () => {
    expect(wrap('')).toMatchObject({ ok: true, lines: [], changed: false });
    expect(wrap('   ')).toMatchObject({ ok: true, changed: false });
  });
});

describe('标点边界与避头尾', () => {
  it('中文在标点边界断行，行首不为“，”', () => {
    const r = wrap('你好，世界你好', { maxWidth: 8 });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.lines).toEqual(['你好，', '世界你好']);
  });

  it('避免行尾为“（”', () => {
    // 两种两行方案行宽差相同（2/4），避尾惩罚决定胜负
    const r = wrap('ab（cd', { maxWidth: 4, maxLines: 2 });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.lines).toEqual(['ab', '（cd']);
  });

  it('超限优先于避尾惩罚：不可避免时允许行尾为“（”', () => {
    // “ab（cdef”宽 8，maxWidth 4：只有断在“（”后才能不超宽
    const r = wrap('ab（cdef', { maxWidth: 4 });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.lines).toEqual(['ab（', 'cdef']);
  });

  it('行首避头字符集与行尾避尾字符集符合约定', () => {
    expect(BAD_LINE_START_CHARS).toBe('，。！？；：、）】》');
    expect(BAD_LINE_END_CHARS).toBe('（【《');
  });
});

describe('限制无法满足时报告原因且不应用', () => {
  it('存在无法断开的超宽片段', () => {
    const r = wrap('abcdefghij', { maxWidth: 5 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain('超过每行最大宽度');
  });

  it('行数不足时报告最少需要行数', () => {
    // “好（好）学”每行宽 4 时最少需要 3 行
    const r = wrap('好（好）学', { maxWidth: 4, maxLines: 2 });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toContain('3 行');
      expect(r.reason).toContain('最多行数 2');
    }
  });
});

describe('手工换行锁定', () => {
  it('锁定：手工换行不可跨越，且计入行数', () => {
    const r = wrap('aaa\nbbb', { maxWidth: 7, lockManualBreaks: true });
    expect(r).toMatchObject({ ok: true, lines: ['aaa', 'bbb'], changed: false });
  });

  it('解锁：手工换行按空白处理，可合并为一行', () => {
    const r = wrap('aaa\nbbb', { maxWidth: 7, lockManualBreaks: false });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.lines).toEqual(['aaa bbb']);
  });

  it('锁定：手工行过多导致行数超限', () => {
    const r = wrap('a\nb\nc', { maxWidth: 10, maxLines: 2, lockManualBreaks: true });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain('3 行');
  });

  it('锁定：手工行内部仍按规则断行', () => {
    const r = wrap('aaa bb cc\ndd', { maxWidth: 6, lockManualBreaks: true });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.lines).toEqual(['aaa', 'bb cc', 'dd']);
  });
});

describe('标签保留', () => {
  it('HTML 标签保留在原文位置且不计宽', () => {
    const r = wrap('<i>hello</i> world', { maxWidth: 6 });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.lines).toEqual(['<i>hello</i>', 'world']);
      expect(r.widths).toEqual([5, 5]);
    }
  });

  it('ASS 标签保留且不计宽', () => {
    const r = wrap('{\\an8}hello world', { maxWidth: 6 });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.lines[0]).toBe('{\\an8}hello');
  });
});

describe('行宽差最小化', () => {
  it('偏好更均衡的分行', () => {
    // “aaaa b ccc”：['aaaa','b ccc']（4/5）优于 ['aaaa b','ccc']（6/3）
    const r = wrap('aaaa b ccc', { maxWidth: 6 });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.lines).toEqual(['aaaa', 'b ccc']);
  });
});
