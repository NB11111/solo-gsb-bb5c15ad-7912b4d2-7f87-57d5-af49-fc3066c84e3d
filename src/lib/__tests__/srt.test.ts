import { describe, expect, it } from 'vitest';
import { formatTimecode, parseSrt, parseTimecode, serializeSrt } from '../srt';

describe('parseSrt', () => {
  it('解析标准块并重新编号', () => {
    const cues = parseSrt('1\n00:00:01,000 --> 00:00:02,500\n你好\n世界\n\n2\n00:00:03,000 --> 00:00:04,000\n第二句\n');
    expect(cues).toHaveLength(2);
    expect(cues[0]).toMatchObject({ id: 0, start: 1000, end: 2500, text: '你好\n世界' });
    expect(cues[1]).toMatchObject({ id: 1, start: 3000 });
  });

  it('兼容 CRLF、BOM 与小数点', () => {
    const cues = parseSrt('﻿5\r\n00:00:01.500 --> 00:00:02.000\r\nhello\r\n');
    expect(cues).toHaveLength(1);
    expect(cues[0].start).toBe(1500);
  });

  it('忽略无时间轴或无文本的块', () => {
    expect(parseSrt('随便一段文字\n\n1\n00:00:01,000 --> 00:00:02,000\n\n')).toHaveLength(0);
  });
});

describe('timecode', () => {
  it('格式化与解析互逆', () => {
    expect(formatTimecode(3_723_004)).toBe('01:02:03,004');
    expect(parseTimecode('01:02:03,004')).toBe(3_723_004);
    expect(parseTimecode('02:03.5')).toBe(123_500);
  });

  it('拒绝非法输入', () => {
    expect(parseTimecode('abc')).toBeNull();
    expect(parseTimecode('00:99:00,000')).toBeNull();
  });
});

describe('serializeSrt', () => {
  it('从 1 重新编号', () => {
    const out = serializeSrt([
      { start: 0, end: 1000, text: 'a' },
      { start: 1000, end: 2000, text: 'b' },
    ]);
    expect(out).toBe('1\n00:00:00,000 --> 00:00:01,000\na\n\n2\n00:00:01,000 --> 00:00:02,000\nb\n');
  });
});
